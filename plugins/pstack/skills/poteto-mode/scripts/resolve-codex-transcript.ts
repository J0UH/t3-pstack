#!/usr/bin/env bun
// Resolve one known Codex chat ID to its rollout file. Prints bounded JSON and
// never prints transcript text.
// From open-pstack (Eric A. Litman and Donncha O'Toole), modified for
// t3-pstack; NOTICE.md lists the changes.
import { constants, Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  resolve as resolvePath,
  sep,
} from "node:path";

const MAX_INDEXES = 8;
const MAX_PATH = 4096;
const MAX_RECORDS = 500;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const CHAT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const INDEX_NAME = /^state_(\d+)\.sqlite$/;
// Bun's Linux build reads `file:` URIs only when the open asks for them.
const OPEN_FLAGS = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI;

class Unresolved extends Error {}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codexHome(): string {
  try {
    return realpathSync(process.env.CODEX_HOME || join(homedir(), ".codex"));
  } catch {
    throw new Unresolved("config_home_unavailable");
  }
}

// A leading `~` is the home directory, as Codex reads it.
function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function realDirectory(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new Unresolved("index_directory_unavailable");
  }
}

// Codex 0.162.1 keeps the index in config.toml's `sqlite_home`, relative to the
// config's directory, else in CODEX_SQLITE_HOME, relative to Codex's working
// directory at startup, else in the home itself.
function indexDirectory(home: string): string {
  let configured: unknown;
  try {
    const config = Bun.TOML.parse(
      readFileSync(join(home, "config.toml"), "utf8")
    );
    configured = (config as { sqlite_home?: unknown }).sqlite_home;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Unresolved("config_unreadable");
    }
  }
  if (typeof configured === "string") {
    return realDirectory(resolvePath(home, expandHome(configured)));
  }
  if (configured !== undefined) throw new Unresolved("config_unreadable");
  const fromEnvironment = process.env.CODEX_SQLITE_HOME?.trim();
  if (!fromEnvironment) return home;
  const path = expandHome(fromEnvironment);
  // A shell command cannot know Codex's working directory at startup.
  if (!isAbsolute(path)) throw new Unresolved("sqlite_home_relative");
  return realDirectory(path);
}

// Newest schema version first: a Codex upgrade leaves the older index behind.
function indexFiles(directory: string): string[] {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => INDEX_NAME.test(name));
  } catch {
    throw new Unresolved("index_directory_unavailable");
  }
  if (names.length > MAX_INDEXES) throw new Unresolved("index_count_budget");
  const version = (name: string) => Number(INDEX_NAME.exec(name)![1]);
  return names
    .sort((a, b) => version(b) - version(a))
    .map((name) => join(directory, name));
}

// The index is the `threads` table keyed by `id` alone, with a `rollout_path` column.
function threadIndex(database: Database): boolean {
  const columns = database.query("PRAGMA table_info(threads)").all() as {
    name: string;
    pk: number;
  }[];
  const id = columns.find((column) => column.name === "id");
  return (
    id?.pk === 1 &&
    columns.every((column) => column.pk === 0 || column === id) &&
    columns.some((column) => column.name === "rollout_path")
  );
}

// Codex leaves the WAL-mode index without its -wal and -shm files once no
// process holds it. A read-only open of that index then creates both files
// beside it, or fails where it cannot, so an index with no -wal file, whose
// rows are all in the database file, opens as immutable. A live index opens
// read-only to see the rows in its -wal file, and as immutable if that fails.
function openIndex(path: string): Database | "not_index" | "unreadable" {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return "unreadable";
  }
  if (dirname(real) !== dirname(path) || !statSync(real).isFile()) {
    throw new Unresolved("index_path_scope");
  }
  const immutable = `file:${real.split("/").map(encodeURIComponent).join("/")}?immutable=1`;
  const live = existsSync(`${real}-wal`);
  for (const name of live ? [real, immutable] : [immutable]) {
    let database: Database | undefined;
    try {
      database = new Database(name, OPEN_FLAGS);
      if (threadIndex(database)) return database;
      database.close();
      // The immutable open of a live index cannot see a schema still in its -wal file.
      return live && name === immutable ? "unreadable" : "not_index";
    } catch {
      database?.close();
    }
  }
  return "unreadable";
}

function indexedRollout(home: string, chatId: string): string {
  let reason = "index_missing";
  for (const path of indexFiles(indexDirectory(home))) {
    const index = openIndex(path);
    if (index === "unreadable") reason = "index_unreadable";
    if (typeof index === "string") continue;
    let row: { rollout_path: unknown } | null;
    try {
      row = index
        .query("SELECT rollout_path FROM threads WHERE id = ?1")
        .get(chatId) as { rollout_path: unknown } | null;
    } catch {
      throw new Unresolved("index_unreadable");
    } finally {
      index.close();
    }
    if (!row) throw new Unresolved("chat_missing");
    const rollout = row.rollout_path;
    if (typeof rollout !== "string" || !rollout || rollout.length > MAX_PATH) {
      throw new Unresolved("rollout_path_invalid");
    }
    return rollout;
  }
  throw new Unresolved(reason);
}

function scopedRollout(home: string, indexed: string): string {
  if (!isAbsolute(indexed)) throw new Unresolved("rollout_path_scope");
  let path: string;
  let sessions: string;
  try {
    path = realpathSync(indexed);
    sessions = realpathSync(join(home, "sessions"));
  } catch {
    throw new Unresolved("rollout_unavailable");
  }
  if (!path.startsWith(sessions + sep))
    throw new Unresolved("rollout_path_scope");
  try {
    if (
      !path.endsWith(".jsonl") ||
      path.length > MAX_PATH ||
      !statSync(path).isFile()
    ) {
      throw new Unresolved("rollout_path_invalid");
    }
  } catch (error) {
    if (error instanceof Unresolved) throw error;
    throw new Unresolved("rollout_unavailable");
  }
  return path;
}

// Reads one byte past the total limit so an oversized file is detected, not truncated.
function readPrefix(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(
        descriptor,
        buffer,
        length,
        buffer.length - length,
        length
      );
      if (read === 0) break;
      length += read;
    }
    return buffer.subarray(0, length);
  } catch {
    throw new Unresolved("rollout_unavailable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function parseRecord(raw: Buffer): JsonObject | null {
  let record: unknown;
  try {
    const text = decoder.decode(raw);
    if (!text.trim()) return null;
    record = JSON.parse(text);
  } catch {
    throw new Unresolved("rollout_malformed");
  }
  if (!isObject(record)) throw new Unresolved("rollout_malformed");
  return record;
}

// Codex takes a rollout's first session_meta as its own; a fork copies its
// parent's after it.
function verifyOwner(path: string, chatId: string): void {
  const buffer = readPrefix(path);
  let consumed = 0;
  for (let line = 1; line <= MAX_RECORDS; line++) {
    const allowance = Math.min(MAX_RECORD_BYTES, MAX_BYTES - consumed);
    if (allowance <= 0) throw new Unresolved("rollout_byte_budget");
    if (consumed === buffer.length)
      throw new Unresolved("rollout_owner_unverified");
    const newline = buffer.indexOf(0x0a, consumed);
    const end = newline === -1 ? buffer.length : newline + 1;
    if (end - consumed > allowance) {
      throw new Unresolved(
        allowance === MAX_RECORD_BYTES
          ? "rollout_line_budget"
          : "rollout_byte_budget"
      );
    }
    const record = parseRecord(buffer.subarray(consumed, end));
    consumed = end;
    if (record?.type !== "session_meta") continue;
    if (!isObject(record.payload) || record.payload.id !== chatId) {
      throw new Unresolved("rollout_owner_mismatch");
    }
    return;
  }
  throw new Unresolved("rollout_record_budget");
}

function resolve(chatId: string) {
  if (!CHAT_ID.test(chatId)) throw new Unresolved("chat_id_invalid");
  const home = codexHome();
  const path = scopedRollout(home, indexedRollout(home, chatId));
  verifyOwner(path, chatId);
  return { status: "resolved", chat_id: chatId, path };
}

const args = process.argv.slice(2);
try {
  if (args.length !== 1) throw new Unresolved("usage");
  console.log(JSON.stringify(resolve(args[0]!)));
} catch (error) {
  const reason = error instanceof Unresolved ? error.message : "internal_error";
  console.log(
    JSON.stringify({ status: "unresolved", reason, fallback: "session_digest" })
  );
  process.exitCode = 1;
}
