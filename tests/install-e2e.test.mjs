// The installer end to end, with the real claude and codex CLIs, in a
// throwaway HOME that T3's settings file describes. Opt in with
// T3_PSTACK_E2E=1; it needs both CLIs and takes about a minute. This checkout
// is the marketplace source. The Codex probe turn has no credentials, so it
// fails at the model call, after the session-start hook has run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { AppServer } from "../tools/install/codex.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const version = JSON.parse(readFileSync(join(repoRoot, "plugins/pstack/.claude-plugin/plugin.json"), "utf8")).version;
const ROUTING = "You have t3-pstack, pstack for T3 Code.";
const SHEET = "# budget: large (xhigh)\nbug-fix: inherit-parent\nsession hook: on\n";

let root;
let home;
const saved = {};
const ISOLATED = ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "T3CODE_HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL"];

function sh(bin, args, env = {}) {
  const r = spawnSync(bin, args, { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
  expect(r.status, `${bin} ${args.join(" ")}\n${r.stdout}\n${r.stderr}`).toBe(0);
  return r.stdout;
}

function installer(command, source = repoRoot) {
  const r = spawnSync("node", [join(repoRoot, "tools/install.mjs"), command, "--source", source, "--json"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  return { status: r.status, report: JSON.parse(r.stdout) };
}

const row = (report, dir) => report.homes.find((h) => h.dir === join(home, dir));
const failing = (checks) => checks.filter((c) => !c.ok && !c.warn).map((c) => `${c.name}: ${c.detail}`);

async function until(done, ms) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((r) => setTimeout(r, 200))) {
    if (done()) return true;
  }
  return false;
}

// A T3-shaped Codex session: thread/start, then one turn. SessionStart runs
// at the first turn, before the model call.
async function probe(codexHome) {
  const server = await AppServer.start({ dir: codexHome, bin: "codex" });
  try {
    const { thread } = await server.request("thread/start", { cwd: root, approvalPolicy: "never", sandbox: "read-only" });
    await server.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "ping" }] });
    expect(await until(() => server.notifications.some((m) => m.method === "turn/completed"), 90_000), "turn completed").toBe(true);
    const rollout = readFileSync(thread.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const developer = rollout
      .filter((item) => item.payload?.type === "message" && item.payload.role === "developer")
      .flatMap((item) => item.payload.content.map((part) => part.text ?? ""));
    return {
      hookEvents: server.notifications.filter((m) => m.method.startsWith("hook/")).map((m) => m.method),
      routedMessages: developer.filter((text) => text.includes(ROUTING)).length,
      rollout: thread.path,
    };
  } finally {
    server.close();
  }
}

// Every config file in every home, and the sheet, by content.
function snapshot() {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["cache", "marketplaces", ".tmp", "sessions", "log", "skills", "shell_snapshots"].includes(entry.name)) walk(path);
      } else if (/\.(json|toml|md)$/.test(entry.name)) {
        out[relative(home, path)] = entry.isSymbolicLink()
          ? `-> ${readlinkSync(path)}`
          : createHash("sha256").update(readFileSync(path)).digest("hex");
      }
    }
  };
  walk(home);
  return out;
}

const enabled = process.env.T3_PSTACK_E2E === "1";

// A fresh HOME per suite, with T3's settings listing `providerInstances`.
function isolate(providerInstances) {
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "t3-pstack-e2e-")));
    home = join(root, "home");
    for (const name of ISOLATED) saved[name] = process.env[name];
    for (const name of ISOLATED) delete process.env[name];
    Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" });
    mkdirSync(join(home, ".t3/userdata"), { recursive: true });
    writeFileSync(join(home, ".t3/userdata/settings.json"), JSON.stringify({ providerInstances }));
  });

  afterAll(() => {
    for (const name of ISOLATED) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(root, { recursive: true, force: true });
  });
}

describe.skipIf(!enabled)("the installer, end to end", () => {
  isolate({
    claudeAgent: { driver: "claudeAgent", enabled: true, config: { binaryPath: "claude", homePath: "" } },
    claude_pool: { driver: "claudeAgent", enabled: true, config: { homePath: "~/.claude-pool" } },
    codex: { driver: "codex", enabled: true, config: { binaryPath: "codex", homePath: "" } },
    codex_work: { driver: "codex", enabled: false, config: { homePath: "~/.codex-work" } },
  });

  test("before: a hand-installed Codex home never runs the hook, and doctor says so", async () => {
    // The pre-installer README way, and the released per-home sheet.
    const codexHome = join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    sh("codex", ["plugin", "marketplace", "add", repoRoot], { CODEX_HOME: codexHome });
    sh("codex", ["plugin", "add", "t3-pstack@t3-pstack"], { CODEX_HOME: codexHome });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude/t3-pstack-models.md"), SHEET);
    symlinkSync(join(home, ".claude/t3-pstack-models.md"), join(codexHome, "t3-pstack-models.md"));

    // A second Claude home with a stale project-scope record for the home folder.
    const pool = join(home, ".claude-pool");
    mkdirSync(pool, { recursive: true });
    sh("claude", ["plugin", "marketplace", "add", repoRoot], { CLAUDE_CONFIG_DIR: pool });
    sh("claude", ["plugin", "install", "t3-pstack@t3-pstack", "--scope", "user"], { CLAUDE_CONFIG_DIR: pool });
    const recordsPath = join(pool, "plugins/installed_plugins.json");
    const records = JSON.parse(readFileSync(recordsPath, "utf8"));
    records.plugins["t3-pstack@t3-pstack"].push({
      scope: "project",
      projectPath: home,
      installPath: join(pool, "plugins/cache/t3-pstack/t3-pstack/1.0.11"),
      version: "1.0.11",
      installedAt: "2026-10-13T04:43:26.759Z",
      lastUpdated: "2026-10-13T04:43:26.759Z",
    });
    writeFileSync(recordsPath, JSON.stringify(records, null, 2) + "\n");

    const before = await probe(codexHome);
    console.log("before:", JSON.stringify(before));
    expect(before.hookEvents).toEqual([]);
    expect(before.routedMessages).toBe(0);

    const { status, report } = installer("doctor");
    expect(status).toBe(1);
    expect(failing(row(report, ".codex").checks)).toEqual([
      "session-start hook trusted: t3-pstack@t3-pstack:hooks/codex-hooks.json:session_start:0:0 untrusted",
    ]);
    expect(failing(row(report, ".claude-pool").checks)).toEqual([
      `other-scope records: project ${home} at 1.0.11`,
    ]);
    expect(failing(row(report, ".codex-work").checks)).toEqual(["installed: the home does not exist"]);
    expect(failing(report.sheet.checks)).toEqual([
      `machine sheet: missing; ${join(home, ".claude/t3-pstack-models.md")}, ${join(home, ".codex/t3-pstack-models.md")} not moved yet`,
    ]);
  }, 300_000);

  test("install: every home converges, the hook is trusted, and its routing text reaches the rollout", async () => {
    const { status, report } = installer("install");
    console.log("install:", JSON.stringify(report.homes.map(({ dir, steps }) => ({ dir, steps })).concat(report.sheet.steps)));
    expect(failing([...report.homes.flatMap((h) => h.checks), ...report.sheet.checks])).toEqual([]);
    expect(status).toBe(0);
    expect(row(report, ".codex").steps).toEqual([
      "trusted hook t3-pstack@t3-pstack:hooks/codex-hooks.json:session_start:0:0 (was untrusted)",
    ]);
    expect(row(report, ".codex-work").steps).toEqual([
      `added the t3-pstack marketplace from ${repoRoot.replace(/\/$/, "")}`,
      `installed ${version}`,
      "trusted hook t3-pstack@t3-pstack:hooks/codex-hooks.json:session_start:0:0 (was untrusted)",
    ]);
    const pool = row(report, ".claude-pool").steps;
    expect(pool[0]).toBe(`moved the project-scope record for ${home} from 1.0.11 to ${version}`);
    expect(pool[1]).toStartWith("backed up plugins/installed_plugins.json to ");
    expect(report.sheet.steps).toEqual([
      `moved the sheet from ${join(home, ".claude/t3-pstack-models.md")}`,
      `linked ${join(home, ".claude/t3-pstack-models.md")} to it`,
      `linked ${join(home, ".claude-pool/t3-pstack-models.md")} to it`,
      `linked ${join(home, ".codex-work/t3-pstack-models.md")} to it`,
    ]);
    expect(readFileSync(join(home, ".config/t3-pstack/models.md"), "utf8")).toBe(SHEET);

    const after = await probe(join(home, ".codex"));
    console.log("after:", JSON.stringify(after));
    expect(after.hookEvents).toEqual(["hook/started", "hook/completed"]);
    expect(after.routedMessages).toBe(1);

    // Claude Code needs no trust; the same routing text arrives through its hook.
    const claude = spawnSync("claude", ["-p", "ping", "--output-format", "stream-json", "--verbose"], {
      cwd: root,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: join(home, ".claude-pool"),
        ANTHROPIC_API_KEY: "sk-ant-invalid",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    const hookResponse = claude.stdout
      .split("\n")
      .filter((line) => line.includes('"hook_response"'))
      .map((line) => JSON.parse(line))
      .find((event) => event.hook_event === "SessionStart");
    expect(hookResponse?.output ?? hookResponse?.stdout ?? "", "Claude Code's SessionStart hook_response").toContain(ROUTING);
    console.log("claude:", JSON.stringify({ hook: hookResponse.hook_name, routed: true }));
  }, 300_000);

  test("a second install changes nothing, and doctor passes", () => {
    const before = snapshot();
    const { status, report } = installer("update");
    expect(status).toBe(0);
    expect([...report.homes.flatMap((h) => h.steps), ...report.sheet.steps]).toEqual([]);
    expect(snapshot()).toEqual(before);
    console.log(`rerun: ${Object.keys(before).length} config files unchanged`);
    expect(installer("doctor").status).toBe(0);
    expect(existsSync(join(home, ".codex-work/config.toml"))).toBe(true);
  }, 300_000);
});

describe.skipIf(!enabled)("the installer, on a release that changes the hook entry", () => {
  isolate({});

  test("updates both homes and trusts the changed hook again", async () => {
    const source = join(root, "source");
    for (const path of [".claude-plugin", ".agents", "plugins"]) {
      cpSync(join(repoRoot, path), join(source, path), { recursive: true, filter: (src) => !src.includes("node_modules") });
    }
    expect(installer("install", source).status).toBe(0);

    const next = "9.9.9";
    for (const file of [".claude-plugin/marketplace.json", "plugins/pstack/.claude-plugin/plugin.json", "plugins/pstack/.codex-plugin/plugin.json"]) {
      const path = join(source, file);
      writeFileSync(path, readFileSync(path, "utf8").replace(`"version": "${version}"`, `"version": "${next}"`));
    }
    const hooks = join(source, "plugins/pstack/hooks/codex-hooks.json");
    writeFileSync(hooks, readFileSync(hooks, "utf8").replace("startup|resume|clear|compact", "startup|resume|compact|clear"));

    const { status, report } = installer("update", source);
    console.log("release:", JSON.stringify(report.homes.map(({ dir, steps }) => ({ dir: relative(home, dir), steps }))));
    expect(failing([...report.homes.flatMap((h) => h.checks), ...report.sheet.checks])).toEqual([]);
    expect(status).toBe(0);
    expect(row(report, ".claude").steps).toEqual([`updated ${version} to ${next}`]);
    expect(row(report, ".codex").steps).toEqual([
      `updated ${version} to ${next}`,
      "trusted hook t3-pstack@t3-pstack:hooks/codex-hooks.json:session_start:0:0 (was modified)",
    ]);
    const after = await probe(join(home, ".codex"));
    expect(after.hookEvents).toEqual(["hook/started", "hook/completed"]);
    expect(after.routedMessages).toBe(1);
  }, 300_000);
});
