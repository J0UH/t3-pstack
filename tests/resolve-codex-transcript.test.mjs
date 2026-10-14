// Ported from open-pstack's resolve-codex-transcript.test.ts (ericlitman/open-pstack#151).
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const SCRIPTS = join(import.meta.dir, "../plugins/pstack/skills/poteto-mode/scripts");
const RESOLVER = join(SCRIPTS, "resolve-codex-transcript.ts");
const LAUNCHER = join(SCRIPTS, "resolve-codex-transcript");
const REFLECT = readFileSync(join(import.meta.dir, "../plugins/pstack/skills/reflect/SKILL.md"), "utf8");
const CHAT = "00000000-1111-2222-3333-444444444444";
const OTHER = "00000000-1111-2222-3333-555555555555";
const OPENING = "Reflect on this synthetic request.";

const metadata = (chat = CHAT) => ({ type: "session_meta", payload: { id: chat } });
const user = (text = OPENING) => ({
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
});

let root;
let home;
let rollout;

function writeRecords(records, path = rollout) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((record) => JSON.stringify(record) + "\n").join(""));
}

function index(name = "state_5.sqlite", rows = [[CHAT, rollout]]) {
  const database = new Database(join(home, name));
  database.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  for (const row of rows) database.run("INSERT INTO threads VALUES (?, ?)", row);
  database.close();
}

function setRolloutPath(path) {
  const database = new Database(join(home, "state_5.sqlite"));
  database.run("UPDATE threads SET rollout_path = ?", [path]);
  database.close();
}

function run(args = [CHAT], env = { CODEX_HOME: home }, cwd) {
  const environment = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined) environment[key] = value;
  }
  const result = Bun.spawnSync([process.execPath, RESOLVER, ...args], { env: environment, cwd });
  const stdout = result.stdout.toString();
  expect(result.stderr.toString()).toBe("");
  expect(stdout.length).toBeLessThan(5000);
  return { code: result.exitCode, result: JSON.parse(stdout) };
}

function expectUnresolved(reason, args) {
  const { code, result } = run(args);
  expect(result).toEqual({ status: "unresolved", reason, fallback: "session_digest" });
  expect(code).toBe(1);
}

function snapshot() {
  const files = {};
  for (const name of readdirSync(home, { recursive: true })) {
    const path = join(home, name);
    try {
      files[relative(home, path)] = readFileSync(path).toString("base64");
    } catch {
      // Directories have no bytes to compare.
    }
  }
  return files;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pstack reflect ")));
  home = join(root, "codex # redirected home");
  rollout = join(home, "sessions/2026/10/05/known.jsonl");
  mkdirSync(home);
  writeRecords([metadata(), user()]);
  index();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolve-codex-transcript", () => {
  it("resolves the rollout in a redirected home without writing or printing its text", () => {
    writeRecords([
      metadata(),
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "response_item", payload: { type: "message", role: "developer", content: [] } },
      user(),
    ]);
    const before = snapshot();
    const { code, result } = run();
    expect(code).toBe(0);
    expect(result).toEqual({ status: "resolved", chat_id: CHAT, path: rollout });
    expect(JSON.stringify(result)).not.toContain(OPENING);
    expect(snapshot()).toEqual(before);
  });

  it("uses $HOME/.codex when CODEX_HOME is unset or empty", () => {
    symlinkSync(home, join(root, ".codex"));
    for (const value of [undefined, ""]) {
      const { code, result } = run([CHAT], { HOME: root, CODEX_HOME: value });
      expect(code).toBe(0);
      expect(result.path).toBe(rollout);
    }
  });

  it("looks up only the exact known chat ID", () => {
    unlinkSync(join(home, "state_5.sqlite"));
    index("state_5.sqlite", [
      [OTHER, join(root, "unrelated-private.jsonl")],
      [CHAT + "suffix", join(root, "another-private.jsonl")],
      [CHAT, rollout],
    ]);
    const { code, result } = run();
    expect(code).toBe(0);
    expect(result.chat_id).toBe(CHAT);
    expectUnresolved("chat_missing", ["00000000-1111-2222-3333-666666666666"]);
  });

  it("ignores unrelated databases and tables", () => {
    const other = new Database(join(home, "logs_2.sqlite"));
    other.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
    other.close();
    const unrelated = new Database(join(home, "state_4.sqlite"));
    unrelated.run("CREATE TABLE unrelated (private_value TEXT)");
    unrelated.run("INSERT INTO unrelated VALUES ('unrelated private sentinel')");
    unrelated.close();
    const { code, result } = run();
    expect(code).toBe(0);
    expect(JSON.stringify(result)).not.toContain("sentinel");
  });

  it("rejects a missing index", () => {
    unlinkSync(join(home, "state_5.sqlite"));
    expectUnresolved("index_missing");
  });

  it("rejects an index without the threads schema", () => {
    unlinkSync(join(home, "state_5.sqlite"));
    const database = new Database(join(home, "state_5.sqlite"));
    database.run("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)");
    database.close();
    expectUnresolved("index_missing");
  });

  it("rejects a threads table whose id is not its key", () => {
    unlinkSync(join(home, "state_5.sqlite"));
    const database = new Database(join(home, "state_5.sqlite"));
    database.run("CREATE TABLE threads (id TEXT, rollout_path TEXT)");
    database.close();
    expectUnresolved("index_missing");
  });

  it("uses the newest index version that opens as the thread index", () => {
    const outside = join(root, "private.jsonl");
    writeRecords([metadata(), user()], outside);
    writeFileSync(join(home, "state_4.sqlite"), "stale unreadable index");
    index("state_9.sqlite", [[CHAT, outside]]);
    index("state_10.sqlite");
    const other = new Database(join(home, "state_11.sqlite"));
    other.run("CREATE TABLE unrelated (private_value TEXT)");
    other.close();
    expect(run().result.path).toBe(rollout);
    unlinkSync(join(home, "state_10.sqlite"));
    expectUnresolved("rollout_path_scope");
  });

  it("rejects too many index files", () => {
    for (let number = 0; number < 8; number++) {
      writeFileSync(join(home, `state_${20 + number}.sqlite`), "");
    }
    expectUnresolved("index_count_budget");
  });

  it("rejects an unreadable index without exposing parse errors", () => {
    writeFileSync(join(home, "state_5.sqlite"), "unrelated private sentinel");
    expectUnresolved("index_unreadable");
  });

  it("reads a WAL index whose rows are still in the -wal file", () => {
    unlinkSync(join(home, "state_5.sqlite"));
    const writer = new Database(join(home, "state_5.sqlite"));
    writer.run("PRAGMA journal_mode = WAL");
    writer.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    writer.run("INSERT INTO threads VALUES (?, ?)", [CHAT, rollout]);
    try {
      expect(existsSync(join(home, "state_5.sqlite-wal"))).toBe(true);
      expect(run().result.path).toBe(rollout);
    } finally {
      writer.close();
    }
  });

  it("reads a closed WAL index whose -wal and -shm files are gone, without creating them", () => {
    unlinkSync(join(home, "state_5.sqlite"));
    const writer = new Database(join(home, "state_5.sqlite"));
    writer.run("PRAGMA journal_mode = WAL");
    writer.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    writer.run("INSERT INTO threads VALUES (?, ?)", [CHAT, rollout]);
    writer.close();
    rmSync(join(home, "state_5.sqlite-wal"), { force: true });
    rmSync(join(home, "state_5.sqlite-shm"), { force: true });
    expect(readFileSync(join(home, "state_5.sqlite"))[18]).toBe(2);
    const before = snapshot();
    expect(run().result.path).toBe(rollout);
    expect(snapshot()).toEqual(before);
  });

  // The writer's -shm file is not copied, and a read-only open cannot create it.
  it.skipIf(process.getuid?.() === 0)(
    "reports a live index whose schema is only in its -wal file as unreadable (skipped as root)",
    () => {
      const live = join(root, "live index");
      mkdirSync(live);
      unlinkSync(join(home, "state_5.sqlite"));
      const writer = new Database(join(home, "state_5.sqlite"));
      writer.run("PRAGMA journal_mode = WAL");
      writer.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
      writer.run("INSERT INTO threads VALUES (?, ?)", [CHAT, rollout]);
      for (const name of ["state_5.sqlite", "state_5.sqlite-wal"]) copyFileSync(join(home, name), join(live, name));
      writer.close();
      chmodSync(live, 0o555);
      try {
        const { code, result } = run([CHAT], { CODEX_HOME: home, CODEX_SQLITE_HOME: live });
        expect(result).toEqual({ status: "unresolved", reason: "index_unreadable", fallback: "session_digest" });
        expect(code).toBe(1);
      } finally {
        chmodSync(live, 0o755);
      }
    },
  );

  it("reads the index from config.toml's sqlite_home, else CODEX_SQLITE_HOME", () => {
    const elsewhere = join(root, "sqlite home");
    const empty = join(root, "empty");
    mkdirSync(elsewhere);
    mkdirSync(empty);
    renameSync(join(home, "state_5.sqlite"), join(elsewhere, "state_5.sqlite"));
    expectUnresolved("index_missing");
    expect(run([CHAT], { CODEX_HOME: home, CODEX_SQLITE_HOME: ` ${elsewhere} ` }).result.path).toBe(rollout);
    writeFileSync(join(home, "config.toml"), 'model = "m"\nsqlite_home = "../sqlite home"\n');
    expect(run([CHAT], { CODEX_HOME: home, CODEX_SQLITE_HOME: empty }).result.path).toBe(rollout);
    writeFileSync(join(home, "config.toml"), 'sqlite_home = "~/sqlite home"\n');
    expect(run([CHAT], { CODEX_HOME: home, HOME: root }).result.path).toBe(rollout);
    writeFileSync(join(home, "config.toml"), "sqlite_home = 5\n");
    expectUnresolved("config_unreadable");
  });

  // Codex reads a relative CODEX_SQLITE_HOME against its working directory at startup.
  it("refuses a relative CODEX_SQLITE_HOME instead of guessing its base", () => {
    const elsewhere = join(root, "sqlite home");
    mkdirSync(elsewhere);
    renameSync(join(home, "state_5.sqlite"), join(elsewhere, "state_5.sqlite"));
    const { code, result } = run([CHAT], { CODEX_HOME: home, CODEX_SQLITE_HOME: "sqlite home" }, root);
    expect(result).toEqual({ status: "unresolved", reason: "sqlite_home_relative", fallback: "session_digest" });
    expect(code).toBe(1);
    expect(run([CHAT], { CODEX_HOME: home, HOME: root, CODEX_SQLITE_HOME: "~/sqlite home" }).result.path).toBe(rollout);
  });

  it("rejects an index symlink that escapes the home", () => {
    const outside = join(root, "outside.sqlite");
    renameSync(join(home, "state_5.sqlite"), outside);
    symlinkSync(outside, join(home, "state_5.sqlite"));
    expectUnresolved("index_path_scope");
  });

  it("rejects malformed records without printing their bytes", () => {
    for (const head of [Buffer.from('{"private sentinel":\n'), Buffer.from("[]\n"), Buffer.from([0xff, 0x0a])]) {
      writeFileSync(rollout, Buffer.concat([head, Buffer.from(JSON.stringify(metadata()) + "\n")]));
      expectUnresolved("rollout_malformed");
    }
  });

  it("rejects a rollout owned by another chat", () => {
    writeRecords([metadata(OTHER), user()]);
    expectUnresolved("rollout_owner_mismatch");
  });

  it("takes a forked rollout's first session_meta as its owner, as Codex does", () => {
    const fork = { type: "session_meta", payload: { id: CHAT, forked_from_id: OTHER } };
    const history = { type: "compacted", payload: { pad: "x".repeat(300 * 1024) } };
    writeRecords([fork, metadata(OTHER), history, user()]);
    expect(run().result).toMatchObject({ status: "resolved", path: rollout });
    writeRecords([metadata(OTHER), fork, user()]);
    expectUnresolved("rollout_owner_mismatch");
  });

  it("rejects a rollout without session_meta", () => {
    writeRecords([user()]);
    expectUnresolved("rollout_owner_unverified");
  });

  it("rejects rollout paths outside the home's sessions directory", () => {
    const outside = join(root, "private.jsonl");
    writeRecords([metadata(), user("unrelated private sentinel")], outside);
    setRolloutPath(outside);
    expectUnresolved("rollout_path_scope");
    const inHome = join(home, "archived_sessions/known.jsonl");
    writeRecords([metadata(), user()], inHome);
    setRolloutPath(inHome);
    expectUnresolved("rollout_path_scope");
    setRolloutPath("sessions/2026/10/05/known.jsonl");
    expectUnresolved("rollout_path_scope");
    setRolloutPath("/" + "x".repeat(4096));
    expectUnresolved("rollout_path_invalid");
  });

  it("rejects a rollout symlink that escapes the sessions directory", () => {
    const outside = join(root, "private.jsonl");
    renameSync(rollout, outside);
    symlinkSync(outside, rollout);
    expectUnresolved("rollout_path_scope");
  });

  it("bounds a rollout symlink loop", () => {
    unlinkSync(rollout);
    symlinkSync(rollout, rollout);
    expectUnresolved("rollout_unavailable");
  });

  it("rejects an invalid chat ID and extra arguments", () => {
    expectUnresolved("chat_id_invalid", ["private title"]);
    expectUnresolved("usage", [CHAT, "--max-lines"]);
  });

  it("stops at 500 records", () => {
    const filler = { type: "event_msg", payload: { type: "token_count" } };
    writeRecords([...Array(499).fill(filler), metadata()]);
    expect(run().result.path).toBe(rollout);
    writeRecords([...Array(500).fill(filler), metadata()]);
    expectUnresolved("rollout_record_budget");
  });

  it("stops at a record over 256 KiB", () => {
    writeRecords([{ type: "event_msg", payload: { pad: "x".repeat(256 * 1024) } }, metadata()]);
    expectUnresolved("rollout_line_budget");
  });

  it("launches without the project's Bun config or .env", () => {
    const project = join(root, "project");
    const decoy = join(root, "decoy-home");
    const marker = join(root, "preload.ran");
    mkdirSync(project);
    mkdirSync(decoy);
    writeFileSync(join(project, "bunfig.toml"), 'preload = ["./project-preload.ts"]\n');
    writeFileSync(
      join(project, "project-preload.ts"),
      `await Bun.write(${JSON.stringify(marker)}, "ran");\nconsole.log("preload stdout");\n`,
    );
    writeFileSync(join(project, ".env"), `CODEX_HOME=${decoy}\n`);
    symlinkSync(home, join(root, ".codex"));
    const env = { PATH: process.env.PATH, HOME: root };
    const direct = Bun.spawnSync([process.execPath, RESOLVER, CHAT], { cwd: project, env });
    expect(existsSync(marker)).toBe(true);
    expect(direct.stdout.toString()).toContain("preload stdout");
    expect(direct.stdout.toString()).toContain('"reason":"index_missing"');
    rmSync(marker);
    const launched = Bun.spawnSync([LAUNCHER, CHAT], { cwd: project, env });
    expect(launched.stderr.toString()).toBe("");
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse(launched.stdout.toString())).toMatchObject({ status: "resolved", path: rollout });
    expect(launched.exitCode).toBe(0);
  });

  it("runs as reflect's step 1 gives the command, from a plugin path with a space", () => {
    const command = REFLECT.match(/^("<plugin root>\/skills\/poteto-mode\/scripts\/resolve-codex-transcript" .*)$/m)?.[1];
    if (command === undefined) throw new Error("reflect/SKILL.md has no resolver command");
    const plugin = join(root, "plugin install");
    symlinkSync(join(import.meta.dir, "../plugins/pstack"), plugin);
    const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, CODEX_THREAD_ID: CHAT };
    const launched = Bun.spawnSync(["sh", "-c", command.replace("<plugin root>", plugin)], { env });
    expect(launched.stderr.toString()).toBe("");
    expect(JSON.parse(launched.stdout.toString())).toMatchObject({ status: "resolved", path: rollout });
    expect(launched.exitCode).toBe(0);
  });

  it("stops at 2 MiB in total", () => {
    const record = { type: "event_msg", payload: { pad: "x".repeat(250 * 1024) } };
    writeRecords([...Array(9).fill(record), metadata()]);
    expectUnresolved("rollout_byte_budget");
  });
});
