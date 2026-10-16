// poteto-mode's worktree-audit.sh reads PR state from Origin's CLI when it
// can and from gh otherwise. Most hosts have no Origin CLI, so the gh path is
// the one that runs: here it gets a PATH with a fake gh and no origin at all.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { validatePluginLayout } from "../tools/generate.mjs";

const audit = fileURLToPath(
  new URL("../plugins/pstack/skills/poteto-mode/scripts/worktree-audit.sh", import.meta.url),
);
const pluginRoot = fileURLToPath(new URL("../plugins/pstack", import.meta.url));
const TOOLS = ["git", "jq", "du", "awk", "sort", "date", "mktemp", "grep", "head", "rm", "xargs", "stat"];

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...gitEnv },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function commit(cwd, name) {
  writeFileSync(join(cwd, `${name}.txt`), `${name}\n`);
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", name);
}

// A repo whose main is pushed to a bare origin, and a bin directory holding
// only the tools the audit runs, so no gh or origin CLI is on PATH.
function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "worktree-audit-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(root, "init", "--bare", "remote.git");
  git(repo, "init");
  git(repo, "remote", "add", "origin", join(root, "remote.git"));
  commit(repo, "base");
  git(repo, "push", "-q", "origin", "main");
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const tool of TOOLS) symlinkSync(Bun.which(tool), join(bin, tool));
  return { root, repo, bin };
}

function addWorktree({ root, repo }, name, ...flags) {
  const tree = join(root, name);
  git(repo, "worktree", "add", "-q", ...(flags.length ? flags : ["-b", name]), tree);
  return tree;
}

// The audit's rows keyed by worktree directory name.
function runAudit({ root, repo, bin }, ...args) {
  const result = spawnSync(Bun.which("bash"), [audit, ...args, repo], {
    encoding: "utf8",
    env: { ...gitEnv, PATH: bin, HOME: root },
  });
  expect(result.stderr).not.toContain("error:");
  expect(result.status).toBe(0);
  return Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .slice(2)
      .map((line) => line.split("\t"))
      .map((cells) => [
        cells[8].split("/").at(-1),
        { merged: cells[2], dirty: cells[3], pr: cells[5], lastChat: cells[6], bucket: cells[7] },
      ]),
  );
}

test("fills the PR column from gh when no origin command is on PATH", () => {
  const fixture = createFixture();
  for (const branch of ["shipped", "in-review", "no-pr"]) commit(addWorktree(fixture, branch), branch);
  const calls = join(fixture.root, "gh-calls");
  writeFileSync(
    join(fixture.bin, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
printf '%s' '[{"number":7,"state":"MERGED","headRefName":"shipped"},{"number":8,"state":"OPEN","headRefName":"in-review"}]'
`,
  );
  chmodSync(join(fixture.bin, "gh"), 0o755);

  const env = { ...gitEnv, PATH: fixture.bin, HOME: fixture.root };
  expect(spawnSync(Bun.which("bash"), ["-c", "command -v origin"], { env }).status).toBe(1);
  const rows = runAudit(fixture);
  expect(readFileSync(calls, "utf8")).toBe(
    "pr list --author @me --state all --limit 1000 --json number,state,headRefName\n",
  );
  const summary = ({ pr, lastChat, bucket }) => ({ pr, lastChat, bucket });
  expect(Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, summary(row)]))).toEqual({
    shipped: { pr: "#7/merged", lastChat: "-", bucket: "safe" },
    "in-review": { pr: "#8/open", lastChat: "-", bucket: "hold-open-pr" },
    "no-pr": { pr: "-", lastChat: "-", bucket: "review" },
  });
});

test("an ignored file outside build and cache directories holds the worktree, ignored dependencies do not", () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.repo, ".git/info/exclude"), ".env\nnode_modules/\n");
  const secrets = addWorktree(fixture, "secrets");
  writeFileSync(join(secrets, ".env"), "TOKEN=only-here\n");
  const deps = addWorktree(fixture, "deps");
  for (const dir of ["node_modules/pkg", "packages/app/node_modules/pkg"]) {
    mkdirSync(join(deps, dir), { recursive: true });
    writeFileSync(join(deps, dir, "index.js"), "module.exports = {};\n");
  }
  const rows = runAudit(fixture);
  expect([rows.secrets.dirty, rows.secrets.bucket]).toEqual(["ignored:1", "hold-ignored"]);
  expect([rows.deps.dirty, rows.deps.bucket]).toEqual(["clean", "safe"]);
});

test("untracked scratch holds the worktree, since a plain git worktree remove refuses it", () => {
  const fixture = createFixture();
  const notes = addWorktree(fixture, "notes");
  writeFileSync(join(notes, "notes.md"), "run log\n");
  const rows = runAudit(fixture);
  expect([rows.notes.dirty, rows.notes.bucket]).toEqual(["scratch:1", "hold-scratch"]);
});

test("a commit only the worktree's HEAD reflog reaches holds it, a rebased branch's old tip does not", () => {
  const fixture = createFixture();
  const detached = addWorktree(fixture, "detached", "--detach");
  commit(detached, "detached work");
  git(detached, "checkout", "-q", "--detach", "origin/main");
  const rebased = addWorktree(fixture, "rebased");
  commit(rebased, "feature");
  const landed = addWorktree(fixture, "landed");
  commit(landed, "trunk moves");
  git(landed, "push", "-q", "origin", "HEAD:main");
  git(rebased, "rebase", "-q", "origin/main");
  git(rebased, "push", "-q", "origin", "HEAD:main");
  const rows = runAudit(fixture);
  expect([rows.detached.merged, rows.detached.dirty, rows.detached.bucket]).toEqual(["YES", "reflog:1", "hold-reflog"]);
  expect([rows.rebased.merged, rows.rebased.dirty, rows.rebased.bucket]).toEqual(["YES", "clean", "safe"]);
});

test("the audit writes nothing to the repository unless --fetch is given", () => {
  const fixture = createFixture();
  const idle = addWorktree(fixture, "idle");
  // A tracked file whose mtime no longer matches the index, so a plain git
  // status would rewrite the index under another agent's feet.
  utimesSync(join(idle, "base.txt"), new Date(0), new Date(0));
  const index = git(idle, "rev-parse", "--path-format=absolute", "--git-path", "index").trim();
  git(fixture.root, "clone", "-q", "remote.git", "other");
  const other = join(fixture.root, "other");
  commit(other, "later");
  git(other, "push", "-q", "origin", "main");
  const tracked = git(fixture.repo, "rev-parse", "origin/main");
  const indexBytes = readFileSync(index);

  runAudit(fixture);
  expect(git(fixture.repo, "rev-parse", "origin/main")).toBe(tracked);
  expect(readFileSync(index).equals(indexBytes)).toBe(true);

  runAudit(fixture, "--fetch");
  expect(git(fixture.repo, "rev-parse", "origin/main")).toBe(git(other, "rev-parse", "HEAD"));
});

test("the generator check rejects a playbook that force-removes a worktree or deletes one by hand", () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-playbook-"));
  roots.push(root);
  const playbooks = join(root, "skills/poteto-mode/playbooks");
  mkdirSync(playbooks, { recursive: true });
  writeFileSync(join(root, "skills/poteto-mode/SKILL.md"), "---\nname: poteto-mode\n---\n");
  writeFileSync(
    join(playbooks, "worktree-cleanup.md"),
    "5. Prune. Per path, `git worktree remove --force <path>`.\nIf the dir survives, `rm -rf` it.\n",
  );
  expect(() => validatePluginLayout(root)).toThrow(
    /worktree-cleanup\.md:1: .*worktree remove --force[\s\S]*worktree-cleanup\.md:2: .*rm -rf/,
  );
  expect(() => validatePluginLayout(pluginRoot)).not.toThrow();
});
