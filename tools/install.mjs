#!/usr/bin/env node
// t3-pstack's installer. `install`, or `update`, the same command, brings
// every Claude Code and Codex home T3 can run to this package's version of
// t3-pstack, trusts the Codex session-start hook, and moves the model sheet to
// its one path per machine. Each step converges, so a second run changes
// nothing. `doctor` checks the same homes and writes nothing itself, though
// the Codex app-server it starts refreshes a Git marketplace, as any T3 Codex
// thread does. Both exit 1 when a check fails.
//
//   npx -y github:chhoumann/t3-pstack <install|update|doctor>
//     --source <path|owner/repo|git URL>   marketplace source, default chhoumann/t3-pstack
//     --claude-home <dir>, --codex-home <dir>   more homes, repeatable
//     --catalog <file>   an orchestrator_capabilities dump to check the sheet's targets against
//     --json
// Node 20 or later, no dependencies.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { doctorClaude, installClaude } from "./install/claude.mjs";
import { doctorCodex, installCodex } from "./install/codex.mjs";
import { check, hasCli, INSTALL_HINT } from "./install/common.mjs";
import { discoverHomes } from "./install/homes.mjs";
import { doctorSheet, moveSheet, sheetPath } from "./install/sheet.mjs";

const HARNESSES = {
  claude: { name: "Claude Code", install: installClaude, doctor: doctorClaude },
  codex: { name: "Codex", install: installCodex, doctor: doctorCodex },
};

const USAGE =
  "usage: t3-pstack <install|update|doctor> [--source <path|owner/repo|git URL>] " +
  "[--claude-home <dir>]... [--codex-home <dir>]... [--catalog <file>] [--json]";

// The version and roles to converge on come from the plugin this run installs:
// the local source, or else this package, which is the marketplace's own repo.
function pluginFacts(root) {
  const plugin = join(root, "plugins/pstack");
  const { roles, tiers } = JSON.parse(readFileSync(join(plugin, "models.json"), "utf8"));
  return {
    version: JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8")).version,
    skills: readdirSync(join(plugin, "skills")),
    roles,
    tiers,
  };
}

async function run(argv, env, home) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      source: { type: "string" },
      "claude-home": { type: "string", multiple: true, default: [] },
      "codex-home": { type: "string", multiple: true, default: [] },
      catalog: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const [command] = positionals;
  if (positionals.length !== 1 || !["install", "update", "doctor"].includes(command)) return { usage: true };

  const localSource = values.source && existsSync(values.source) ? resolve(values.source) : undefined;
  const source = localSource ?? values.source ?? "chhoumann/t3-pstack";
  const facts = pluginFacts(localSource ?? fileURLToPath(new URL("..", import.meta.url)));
  const context = { source, localSource, version: facts.version, skills: facts.skills };
  const { homes, settings } = discoverHomes({
    env,
    home,
    claudeHomes: values["claude-home"],
    codexHomes: values["codex-home"],
  });
  const catalog = values.catalog ? JSON.parse(readFileSync(values.catalog, "utf8")) : null;

  const report = { command, version: facts.version, source, settings, homes: [] };
  for (const target of homes) {
    const harness = HARNESSES[target.harness];
    const row = { harness: target.harness, dir: target.dir, from: target.from, steps: [], checks: [] };
    report.homes.push(row);
    if (!hasCli(target.bin)) {
      row.checks.push(check("CLI", false, `${target.bin} not found, so this home was skipped`, `install ${harness.name} if T3 runs it`, true));
      continue;
    }
    if (command === "doctor" && !existsSync(target.dir)) {
      row.checks.push(check("installed", false, "the home does not exist", INSTALL_HINT));
      continue;
    }
    try {
      if (command !== "doctor") row.steps = await harness.install(target, context);
      row.checks.push(...(await harness.doctor(target, context)));
    } catch (err) {
      row.checks.push(check(command === "doctor" ? "doctor" : "install", false, err.message, INSTALL_HINT));
    }
  }
  const sheet = sheetPath(env, home);
  report.sheet = { path: sheet, steps: [], checks: [] };
  try {
    if (command !== "doctor") report.sheet.steps = moveSheet(sheet, homes);
  } catch (err) {
    report.sheet.checks.push(check("move", false, err.message, INSTALL_HINT));
  }
  report.sheet.checks.push(...doctorSheet(sheet, homes, { catalog, roles: facts.roles, tiers: facts.tiers }));
  const all = [...report.homes.flatMap((row) => row.checks), ...report.sheet.checks];
  report.failed = all.filter((c) => !c.ok && !c.warn).length;
  report.warnings = all.filter((c) => !c.ok && c.warn).length;
  return { report, json: values.json };
}

function render({ command, version, source, settings, homes, sheet, failed, warnings }, home) {
  const lines = [`t3-pstack ${version} from ${source}`];
  lines.push(`T3 settings: ${settings.path}${settings.error ? ` (${settings.error})` : `, ${settings.instances} Claude Code or Codex instances`}`);
  const section = (title, steps, checks) => {
    lines.push("", title);
    for (const step of steps) lines.push(`  - ${step}`);
    for (const c of checks) {
      lines.push(`  ${c.ok ? "ok  " : c.warn ? "warn" : "FAIL"}  ${c.name}: ${c.detail}`);
      if (!c.ok) lines.push(`        fix: ${c.fix}`);
    }
  };
  for (const row of homes) section(`${HARNESSES[row.harness].name}  ${row.dir}  (${row.from.join(", ")})`, row.steps, row.checks);
  section(`Model sheet  ${sheet.path}`, sheet.steps, sheet.checks);
  const changed = [...homes.flatMap((row) => row.steps), ...sheet.steps].length;
  const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  lines.push(
    "",
    `${command === "doctor" ? "" : changed ? `${count(changed, "change")}. ` : "Nothing to change. "}` +
      (failed ? `${count(failed, "check")} failed` : "Every check passes") +
      (warnings ? `, ${count(warnings, "warning")}.` : "."),
  );
  return lines.join("\n").replaceAll(home, "~");
}

const home = homedir();
try {
  const { usage, report, json } = await run(process.argv.slice(2), process.env, home);
  if (usage) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    console.log(json ? JSON.stringify(report, null, 2) : render(report, home));
    process.exitCode = report.failed ? 1 : 0;
  }
} catch (err) {
  console.error(`t3-pstack: ${err.message}`);
  process.exitCode = 2;
}
