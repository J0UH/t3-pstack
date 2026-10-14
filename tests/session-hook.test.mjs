// Each runtime's shipped SessionStart command, run for real: the mandate is
// injected unless that runtime's model sheet turns it off.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentSkills } from "../tools/generate.mjs";
import { sheetCases, writeSheet } from "./session-hook-sheets.mjs";

const pluginRoot = fileURLToPath(new URL("../plugins/pstack/", import.meta.url));
const mandate = readFileSync(join(pluginRoot, "hooks/session-start-context.md"), "utf8");
const codexManifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));

// Claude Code loads hooks/hooks.json by convention; Codex loads the file its
// manifest names.
const sessionStart = Object.fromEntries(
  Object.entries({ claude: "hooks/hooks.json", codex: codexManifest.hooks }).map(([runtime, file]) => [
    runtime,
    JSON.parse(readFileSync(join(pluginRoot, file), "utf8")).hooks.SessionStart[0],
  ]),
);

// CODEX_HOME and CLAUDE_CONFIG_DIR are only present when the user has
// relocated that runtime's directory. PLUGIN_ROOT is a generic name any shell
// profile may export, so it must not move a Claude Code session to Codex's sheet.
const runtimes = {
  claude: { hooks: "claude", sheetDir: ".claude", env: () => ({}) },
  "claude with CLAUDE_CONFIG_DIR": {
    hooks: "claude",
    sheetDir: "claude-config",
    env: (sheetRoot) => ({ CLAUDE_CONFIG_DIR: sheetRoot }),
  },
  "claude with PLUGIN_ROOT exported": { hooks: "claude", sheetDir: ".claude", env: () => ({ PLUGIN_ROOT: pluginRoot }) },
  codex: { hooks: "codex", sheetDir: ".codex", env: () => ({}) },
  "codex with CODEX_HOME": {
    hooks: "codex",
    sheetDir: "codex-home",
    env: (sheetRoot) => ({ CODEX_HOME: sheetRoot }),
  },
};

function runHook(runtime, sheet, command = sessionStart[runtimes[runtime].hooks].hooks[0].command) {
  const home = mkdtempSync(join(tmpdir(), "pstack-hook-"));
  const { sheetDir, env } = runtimes[runtime];
  const sheetRoot = join(home, sheetDir);
  if (sheet !== null) {
    mkdirSync(sheetRoot);
    writeSheet(join(sheetRoot, "t3-pstack-models.md"), sheet);
  }
  try {
    const r = spawnSync("sh", ["-c", command], {
      env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot, ...env(sheetRoot) },
      encoding: "utf8",
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("SessionStart hook", () => {
  // The manifest names Codex's own hooks file instead of relying on Codex's
  // default discovery; `resume` keeps the mandate present after a restart.
  test("declares the hook in the Codex manifest", () => {
    expect(codexManifest.hooks).toBe("./hooks/codex-hooks.json");
    expect(sessionStart.claude.matcher).toBe("startup|resume|clear|compact");
    expect(sessionStart.codex.matcher).toBe("startup|resume|clear|compact");
  });

  // Codex trusts a plugin hook by a hash of its entry, so a changed command,
  // matcher, or timeout silently stops routing on Codex until the user trusts
  // it again. The script and the routing text can change freely.
  test("keeps the hook entries released in 1.0.14", () => {
    expect(sessionStart.claude).toEqual({
      matcher: "startup|resume|clear|compact",
      hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh" claude' }],
    });
    expect(sessionStart.codex).toEqual({
      matcher: "startup|resume|clear|compact",
      hooks: [
        {
          type: "command",
          command: '"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh" codex',
          commandWindows: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.ps1"',
        },
      ],
    });
  });

  test("names only skills that exist", () => {
    const named = [...mandate.matchAll(/(?:pstack:|`\/)([a-z0-9-]+)/g)].map((m) => m[1]);
    const skills = new Set(agentSkills(join(pluginRoot, "skills")).map(({ name }) => name));
    expect(named).toContain("poteto-mode");
    expect(named.filter((name) => !skills.has(name))).toEqual([]);
  });

  for (const arg of ["cursor", "copilot", ""]) {
    test(`fails on runtime argument ${JSON.stringify(arg)}`, () => {
      const r = runHook("claude", null, `"\${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh" ${arg}`);
      expect(r.status).not.toBe(0);
      expect(r.out).toBe("");
      expect(r.err.trimEnd().split("\n")).toEqual([`session-start.sh: unknown runtime '${arg}' (expected claude or codex)`]);
    });
  }

  for (const runtime of Object.keys(runtimes)) {
    const wrap = (out) => out;
    const expected = (off) => (off ? "" : mandate);
    describe(runtime, () => {
      test("injects the mandate when no sheet exists", () => {
        const r = runHook(runtime, null);
        expect({ ...r, out: wrap(r.out) }).toEqual({ status: 0, out: expected(false), err: "" });
      });

      // iconv rejects a UTF-16 LE sheet that ends mid-character, so the hook
      // cannot decode it and must inject as it does for a missing sheet.
      test("injects the mandate when the sheet cannot be decoded", () => {
        const r = runHook(runtime, Buffer.from([0xff, 0xfe, 0x73, 0x00, 0x65]));
        expect({ status: r.status, out: wrap(r.out) }).toEqual({ status: 0, out: expected(false) });
      });

      for (const { name, sheet, off } of sheetCases) {
        test(`${off ? "injects nothing" : "injects the mandate"} when the sheet has ${name}`, () => {
          const r = runHook(runtime, sheet);
          expect({ ...r, out: off ? r.out : wrap(r.out) }).toEqual({ status: 0, out: expected(off), err: "" });
        });
      }
    });
  }
});

describe("each host reads only its own sheet", () => {
  test("an off sheet in the other host's config directory leaves injection on", () => {
    const home = mkdtempSync(join(tmpdir(), "pstack-hook-"));
    try {
      const run = (runtime) =>
        spawnSync("sh", ["-c", sessionStart[runtime].hooks[0].command], {
          env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
          encoding: "utf8",
        }).stdout;
      mkdirSync(join(home, ".codex"));
      writeFileSync(join(home, ".codex", "t3-pstack-models.md"), "session hook: off\n");
      expect(run("claude")).toBe(mandate);
      expect(run("codex")).toBe("");
      rmSync(join(home, ".codex"), { recursive: true });
      mkdirSync(join(home, ".claude"));
      writeFileSync(join(home, ".claude", "t3-pstack-models.md"), "session hook: off\n");
      expect(run("claude")).toBe("");
      expect(run("codex")).toBe(mandate);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
