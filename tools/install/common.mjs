// What the Claude Code and Codex halves of the installer share: the plugin's
// ids, the CLI runner, and the shape of a doctor check.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export const PLUGIN_ID = "t3-pstack@t3-pstack";
export const MARKETPLACE = "t3-pstack";
export const INSTALL_HINT = "rerun `npx -y github:chhoumann/t3-pstack install`";

// Every CLI runs from an empty directory. Claude Code reads `<cwd>/.claude`
// as project settings, and from the home folder that is the main home's
// settings.json, so the user's own working directory could leak into the
// home being installed.
let neutral;
export function neutralCwd() {
  if (!neutral) {
    neutral = mkdtempSync(join(tmpdir(), "t3-pstack-"));
    process.on("exit", () => rmSync(neutral, { recursive: true, force: true }));
  }
  return neutral;
}

export function runCli(bin, args, env) {
  try {
    return execFileSync(bin, args, {
      cwd: neutralCwd(),
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
  } catch (err) {
    throw new Error(`${bin} ${args.join(" ")}: ${(err.stderr || err.stdout || err.message).trim()}`);
  }
}

// Looked up on PATH rather than run: `codex --version` already writes into
// the default CODEX_HOME.
export function hasCli(bin) {
  if (bin.includes("/")) return existsSync(bin);
  const extensions = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE").split(";")] : [""];
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir && extensions.some((ext) => existsSync(join(dir, bin + ext))));
}

// A crash between the write and the rename leaves the old file whole. The
// rename lands on the symlink's target, so a settings file one home links
// from another stays shared.
export function writeAtomic(path, text) {
  const target = existsSync(path) ? realpathSync(path) : path;
  const tmp = join(dirname(target), `.${Date.now()}-${process.pid}.t3-pstack.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, target);
}

// A doctor check. `warn` marks one that never fails the run.
export const check = (name, ok, detail, fix, warn = false) => ({ name, ok, detail, ...(ok ? {} : { fix }), ...(warn && { warn }) });
