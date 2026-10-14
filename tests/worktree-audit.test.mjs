// poteto-mode's worktree-audit.sh reads PR state from Origin's CLI when it
// can and from gh otherwise. Most hosts have no Origin CLI, so the gh path is
// the one that runs: here it gets a PATH with a fake gh and no origin at all.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const audit = fileURLToPath(
  new URL("../plugins/pstack/skills/poteto-mode/scripts/worktree-audit.sh", import.meta.url),
);
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

test("fills the PR column from gh when no origin command is on PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-audit-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(root, "init", "--bare", "remote.git");
  git(repo, "init");
  git(repo, "remote", "add", "origin", join(root, "remote.git"));
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "push", "-q", "origin", "main");
  for (const branch of ["shipped", "in-review", "no-pr"]) {
    const tree = join(root, branch);
    git(repo, "worktree", "add", "-q", "-b", branch, tree);
    writeFileSync(join(tree, `${branch}.txt`), `${branch}\n`);
    git(tree, "add", ".");
    git(tree, "commit", "-m", branch);
  }

  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const tool of TOOLS) symlinkSync(Bun.which(tool), join(bin, tool));
  const calls = join(root, "gh-calls");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
printf '%s' '[{"number":7,"state":"MERGED","headRefName":"shipped"},{"number":8,"state":"OPEN","headRefName":"in-review"}]'
`,
  );
  chmodSync(join(bin, "gh"), 0o755);

  const env = { ...gitEnv, PATH: bin, HOME: root };
  expect(spawnSync(Bun.which("bash"), ["-c", "command -v origin"], { env }).status).toBe(1);
  const result = spawnSync(Bun.which("bash"), [audit, repo], { encoding: "utf8", env });
  expect(result.status).toBe(0);
  expect(readFileSync(calls, "utf8")).toBe(
    "pr list --author @me --state all --limit 1000 --json number,state,headRefName\n",
  );
  const rows = Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .slice(2)
      .map((line) => line.split("\t"))
      .map((cells) => [cells[8].split("/").at(-1), { pr: cells[5], lastChat: cells[6], bucket: cells[7] }]),
  );
  expect(rows).toEqual({
    shipped: { pr: "#7/merged", lastChat: "-", bucket: "safe" },
    "in-review": { pr: "#8/open", lastChat: "-", bucket: "hold-open-pr" },
    "no-pr": { pr: "-", lastChat: "-", bucket: "review" },
  });
});
