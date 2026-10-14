// The installer's file-level behavior, on constructed homes: which homes it
// finds, how it repairs a stale Claude Code record, how it moves the model
// sheet, and what doctor reports. tests/install-e2e.test.mjs drives the real
// CLIs.
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { doctorClaude, syncScopedRecords } from "../tools/install/claude.mjs";
import { discoverHomes } from "../tools/install/homes.mjs";
import { doctorSheet, moveSheet } from "../tools/install/sheet.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const { roles, tiers } = JSON.parse(readFileSync(join(repoRoot, "plugins/pstack/models.json"), "utf8"));
const FIX = "rerun `npx -y github:chhoumann/t3-pstack install`";

const scratch = [];
function tmp() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t3-pstack-install-")));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop(), { recursive: true, force: true });
});
const writeJson = (path, value) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
};

describe("discoverHomes", () => {
  test("resolves each home as T3 does and merges the sources that name it", () => {
    const t3 = tmp();
    writeJson(join(t3, "userdata/settings.json"), {
      providerInstances: {
        claudeAgent: { driver: "claudeAgent", enabled: true, config: { binaryPath: "claude", homePath: "" } },
        claude_pool: { driver: "claudeAgent", config: { homePath: "~/.claude_pool", binaryPath: "/opt/bin/claude" } },
        claude_env: { driver: "claudeAgent", environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/opt/claude-env" }] },
        codex: { driver: "codex", config: { homePath: "", shadowHomePath: "~/.codex-acct2" } },
        codex_pool: { driver: "codex", enabled: false, config: { homePath: "/home/u/.codex-pool" } },
        codex_env: { driver: "codex", config: { enabled: false }, environment: [{ name: "CODEX_HOME", value: "/opt/codex-env" }] },
        grok: { driver: "grok", enabled: true },
      },
    });
    const found = discoverHomes({
      env: { T3CODE_HOME: t3, CODEX_HOME: "/home/u/.codex-acct2", CLAUDE_CONFIG_DIR: "/srv/claude" },
      home: "/home/u",
      claudeHomes: ["~/.claude_pool"],
      codexHomes: ["/data/codex"],
    });
    expect(found).toEqual({
      homes: [
        { harness: "claude", dir: "/home/u/.claude", from: ["default", "T3 instance claudeAgent"], bin: "claude" },
        { harness: "codex", dir: "/home/u/.codex", from: ["default", "T3 instance codex"], bin: "codex" },
        { harness: "claude", dir: "/home/u/.claude_pool", from: ["T3 instance claude_pool", "--claude-home"], bin: "/opt/bin/claude" },
        { harness: "claude", dir: "/opt/claude-env", from: ["T3 instance claude_env"], bin: "claude" },
        { harness: "codex", dir: "/home/u/.codex-pool", from: ["T3 instance codex_pool (disabled)"], bin: "codex" },
        { harness: "codex", dir: "/opt/codex-env", from: ["T3 instance codex_env (disabled)"], bin: "codex" },
        { harness: "claude", dir: "/srv/claude", from: ["CLAUDE_CONFIG_DIR"], bin: "claude" },
        { harness: "codex", dir: "/data/codex", from: ["--codex-home"], bin: "codex" },
      ],
      settings: { path: join(t3, "userdata/settings.json"), instances: 6, error: undefined },
    });
  });

  test("falls back to the defaults when T3's settings are missing", () => {
    const t3 = tmp();
    expect(discoverHomes({ env: { T3CODE_HOME: t3 }, home: "/home/u" })).toEqual({
      homes: [
        { harness: "claude", dir: "/home/u/.claude", from: ["default"], bin: "claude" },
        { harness: "codex", dir: "/home/u/.codex", from: ["default"], bin: "codex" },
      ],
      settings: { path: join(t3, "userdata/settings.json"), instances: 0, error: "not found" },
    });
  });
});

// The record a second config home keeps re-acquiring for the home folder.
function claudeHome({ autoUpdate } = {}) {
  const dir = tmp();
  const user = {
    scope: "user",
    installPath: `${dir}/plugins/cache/t3-pstack/t3-pstack/2.0.0-rc.3`,
    version: "2.0.0-rc.3",
    installedAt: "2026-10-06T08:38:28.344Z",
    lastUpdated: "2026-10-14T11:20:44.228Z",
    gitCommitSha: "1111111111111111111111111111111111111111",
  };
  const project = {
    scope: "project",
    projectPath: "/home/u",
    installPath: `${dir}/plugins/cache/t3-pstack/t3-pstack/1.0.11`,
    version: "1.0.11",
    installedAt: "2026-10-13T04:43:26.759Z",
    lastUpdated: "2026-10-13T04:43:26.759Z",
    gitCommitSha: "0000000000000000000000000000000000000000",
  };
  const other = { scope: "project", projectPath: "/home/u", installPath: "/x", version: "0.1.0" };
  writeJson(join(dir, "plugins/installed_plugins.json"), {
    version: 2,
    plugins: { "t3-pstack@t3-pstack": [user, project], "other@market": [other] },
  });
  writeJson(join(dir, "settings.json"), {
    enabledPlugins: { "t3-pstack@t3-pstack": true },
    extraKnownMarketplaces: {
      "t3-pstack": { source: { source: "github", repo: "chhoumann/t3-pstack" }, ...(autoUpdate && { autoUpdate }) },
    },
  });
  return { dir, user, project, other };
}

describe("a stale other-scope Claude Code record", () => {
  test("moves to the user-scope install, after a backup, and only once", () => {
    const { dir, user, project, other } = claudeHome();
    const path = join(dir, "plugins/installed_plugins.json");
    const original = readFileSync(path, "utf8");

    const steps = syncScopedRecords(dir);
    const backups = readdirSync(join(dir, "plugins")).filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(steps).toEqual([
      "moved the project-scope record for /home/u from 1.0.11 to 2.0.0-rc.3",
      `backed up plugins/installed_plugins.json to ${join(dir, "plugins", backups[0])}`,
    ]);
    expect(readFileSync(join(dir, "plugins", backups[0]), "utf8")).toBe(original);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 2,
      plugins: {
        "t3-pstack@t3-pstack": [
          user,
          { ...project, installPath: user.installPath, version: user.version, gitCommitSha: user.gitCommitSha, lastUpdated: user.lastUpdated },
        ],
        "other@market": [other],
      },
    });

    const fixed = readFileSync(path, "utf8");
    expect(syncScopedRecords(dir)).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(fixed);
    expect(readdirSync(join(dir, "plugins")).filter((name) => name.endsWith(".bak"))).toHaveLength(1);
  });

  test("doctor names it, the missing auto-update, and plain skill copies, and passes once they are fixed", () => {
    const { dir } = claudeHome();
    mkdirSync(join(dir, "skills/how"), { recursive: true });
    const home = { harness: "claude", dir, from: ["default"], bin: "claude" };
    const context = { version: "2.0.0-rc.3", skills: ["how", "why"] };
    expect(doctorClaude(home, context)).toEqual([
      { name: "installed", ok: true, detail: "2.0.0-rc.3" },
      { name: "enabled", ok: true, detail: "yes" },
      { name: "marketplace auto-update", ok: false, detail: "false", fix: FIX },
      { name: "other-scope records", ok: false, detail: "project /home/u at 1.0.11", fix: FIX },
      {
        name: "no plain copies of plugin skills",
        ok: false,
        detail: join(dir, "skills/how"),
        fix: "delete these folders; the plugin ships the same skills",
      },
    ]);
    expect(doctorClaude(home, { ...context, version: "2.0.0-rc.4" })[0]).toEqual({
      name: "installed",
      ok: false,
      detail: "2.0.0-rc.3, expected 2.0.0-rc.4",
      fix: FIX,
    });

    syncScopedRecords(dir);
    rmSync(join(dir, "skills"), { recursive: true });
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    settings.extraKnownMarketplaces["t3-pstack"].autoUpdate = true;
    writeJson(join(dir, "settings.json"), settings);
    expect(doctorClaude(home, context).filter((c) => !c.ok)).toEqual([]);
  });
});

describe("the model sheet", () => {
  const SHEET = "# budget: large (xhigh)\nbug-fix: inherit-parent\nsession hook: on\n";

  function machine() {
    const root = tmp();
    const homes = [".claude", ".codex", ".codex-pool", ".claude-never-run"].map((name) => ({ dir: join(root, name) }));
    for (const { dir } of homes.slice(0, 3)) mkdirSync(dir);
    return { root, homes, sheet: join(root, ".config/t3-pstack/models.md") };
  }

  test("moves a linked home sheet to the machine path once and links every existing home to it", () => {
    const { root, homes, sheet } = machine();
    writeFileSync(join(root, ".claude/t3-pstack-models.md"), SHEET);
    symlinkSync(join(root, ".claude/t3-pstack-models.md"), join(root, ".codex/t3-pstack-models.md"));

    expect(moveSheet(sheet, homes)).toEqual([
      `moved the sheet from ${join(root, ".claude/t3-pstack-models.md")}`,
      `linked ${join(root, ".claude/t3-pstack-models.md")} to it`,
      `linked ${join(root, ".codex-pool/t3-pstack-models.md")} to it`,
    ]);
    expect(readFileSync(sheet, "utf8")).toBe(SHEET);
    expect(readlinkSync(join(root, ".claude/t3-pstack-models.md"))).toBe(sheet);
    expect(readlinkSync(join(root, ".codex/t3-pstack-models.md"))).toBe(join(root, ".claude/t3-pstack-models.md"));
    expect(readlinkSync(join(root, ".codex-pool/t3-pstack-models.md"))).toBe(sheet);
    expect(existsSync(join(root, ".claude-never-run"))).toBe(false);

    expect(moveSheet(sheet, homes)).toEqual([]);
    expect(doctorSheet(sheet, homes, { catalog: null, roles, tiers })).toEqual([
      { name: "machine sheet valid", ok: true, detail: "every line parses (pass --catalog to check targets)" },
      { name: "home sheets", ok: true, detail: "none differ from it" },
    ]);
  });

  test("leaves home sheets that disagree, and doctor says so", () => {
    const { root, homes, sheet } = machine();
    writeFileSync(join(root, ".claude/t3-pstack-models.md"), SHEET);
    writeFileSync(join(root, ".codex/t3-pstack-models.md"), "session hook: off\n");

    expect(moveSheet(sheet, homes)).toEqual([]);
    expect(existsSync(sheet)).toBe(false);
    expect(doctorSheet(sheet, homes, { catalog: null, roles, tiers })).toEqual([
      {
        name: "machine sheet",
        ok: false,
        detail: `missing; ${join(root, ".claude/t3-pstack-models.md")}, ${join(root, ".codex/t3-pstack-models.md")} differ, so the installer leaves them`,
        fix: `keep one, then ${FIX}`,
      },
    ]);
  });

  test("keeps a home sheet that differs from an existing machine sheet, and links one that matches", () => {
    const { root, homes, sheet } = machine();
    mkdirSync(join(root, ".config/t3-pstack"), { recursive: true });
    writeFileSync(sheet, SHEET);
    writeFileSync(join(root, ".claude/t3-pstack-models.md"), SHEET);
    writeFileSync(join(root, ".codex/t3-pstack-models.md"), "session hook: off\n");

    expect(moveSheet(sheet, homes)).toEqual([
      `linked ${join(root, ".claude/t3-pstack-models.md")} to it`,
      `linked ${join(root, ".codex-pool/t3-pstack-models.md")} to it`,
    ]);
    expect(lstatSync(join(root, ".codex/t3-pstack-models.md")).isSymbolicLink()).toBe(false);
    expect(doctorSheet(sheet, homes, { catalog: null, roles, tiers })[1]).toEqual({
      name: "home sheets",
      ok: false,
      detail: `${join(root, ".codex/t3-pstack-models.md")} differ from the machine sheet`,
      fix: `move each aside, then ${FIX} to link it`,
    });
  });

  test("doctor warns without a sheet and fails on a malformed one", () => {
    const { homes, sheet } = machine();
    expect(doctorSheet(sheet, homes, { catalog: null, roles, tiers })).toEqual([
      {
        name: "machine sheet",
        ok: false,
        detail: "none, so every role runs on its skill's defaults",
        fix: "run /t3-pstack:setup-pstack in a T3 thread",
        warn: true,
      },
    ]);
    mkdirSync(join(sheet, ".."), { recursive: true });
    writeFileSync(sheet, "bug-fix: claude-opus\nhow critics: inherit-parent\n");
    expect(doctorSheet(sheet, homes, { catalog: null, roles, tiers })[0]).toEqual({
      name: "machine sheet valid",
      ok: false,
      detail: 'bug-fix: "claude-opus" does not start with <providerInstanceId>/<modelId>; "how critics" is not a pstack role',
      fix: "run /t3-pstack:setup-pstack in a T3 thread",
    });
  });
});
