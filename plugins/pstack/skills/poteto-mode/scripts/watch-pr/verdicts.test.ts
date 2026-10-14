// Michael Denyer's watch-pr fixes from pstack-claude, carried by t3-pstack:
// a PR that waits on a required review or another protection rule is not
// READY (#95), a stale check fails instead of pending forever (#97), and a
// repository with no checks configured gets a verdict instead of retrying
// forever (#151, #152, #153).
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliRuntime, main } from "./cli.ts";
import { fakeReader, passingCheck, pendingCheck } from "./fakes.test-helper.ts";
import {
  ChecksUnavailable,
  WatcherQueryError,
  parseFastCheck,
  resolveChecks,
} from "./github.ts";
import {
  classifyPr,
  readSnapshot,
  selectTierMajorStackDecision,
} from "./policy.ts";
import type { GitHubReader, NonEmpty, PrSnapshot } from "./types.ts";
import { parsePrNumber } from "./types.ts";

const context = (number: number) => ({
  owner: "owner",
  repo: "repo",
  number: parsePrNumber(number),
});

function testRuntime(reader: GitHubReader) {
  const stdout: string[] = [];
  const runtime: CliRuntime = {
    reader,
    clock: {
      now: () => 0,
      observedAt: () => "2026-07-26T00:00:00.000Z",
      async sleep() {
        throw new Error("test unexpectedly slept");
      },
    },
    stdout: (value) => stdout.push(value),
    stderr: () => {},
  };
  return { runtime, stdout };
}

const single = [
  "--owner",
  "owner",
  "--repo",
  "repo",
  "--pr",
  "1",
  "--settle",
  "0",
];

describe("review gate", () => {
  it("blocks on a required review instead of reporting a blocked PR ready", async () => {
    const snapshot = await readSnapshot({
      reader: fakeReader({
        facts: {
          reviewDecision: "REVIEW_REQUIRED",
          mergeStateStatus: "BLOCKED",
        },
      }),
      context: context(23),
      pendingHistory: "omit",
      allowDraft: false,
    });
    expect(classifyPr(snapshot)).toEqual({
      kind: "blocker",
      blocker: {
        kind: "merge-gate",
        pr: context(23),
        reason: "review-required",
      },
    });
    expect(
      selectTierMajorStackDecision([snapshot] as NonEmpty<PrSnapshot>)
    ).toMatchObject({
      kind: "blocker",
      blocker: { kind: "merge-gate", reason: "review-required" },
    });
  });

  it("blocks when branch protection holds an approved PR with clean CI", async () => {
    const snapshot = await readSnapshot({
      reader: fakeReader({ facts: { mergeStateStatus: "BLOCKED" } }),
      context: context(24),
      pendingHistory: "omit",
      allowDraft: false,
    });
    expect(classifyPr(snapshot)).toMatchObject({
      kind: "blocker",
      blocker: { kind: "merge-gate", reason: "merge-blocked" },
    });
  });

  it("waits for pending checks before reporting the review gate", async () => {
    const snapshot = await readSnapshot({
      reader: fakeReader({
        facts: {
          reviewDecision: "REVIEW_REQUIRED",
          mergeStateStatus: "BLOCKED",
        },
        fastPath: { kind: "checks", checks: [pendingCheck()] },
      }),
      context: context(26),
      pendingHistory: "omit",
      allowDraft: false,
    });
    expect(classifyPr(snapshot)).toMatchObject({ kind: "waiting" });
  });

  it("still reports changes requested as a merge-gate blocker", async () => {
    const snapshot = await readSnapshot({
      reader: fakeReader({
        facts: {
          reviewDecision: "CHANGES_REQUESTED",
          mergeStateStatus: "BLOCKED",
        },
      }),
      context: context(25),
      pendingHistory: "omit",
      allowDraft: false,
    });
    expect(classifyPr(snapshot)).toMatchObject({
      kind: "blocker",
      blocker: { kind: "merge-gate", reason: "changes-requested" },
    });
  });

  it("exits 6 and names the review in the status table and the blocker", async () => {
    const reader = () =>
      fakeReader({
        facts: {
          reviewDecision: "REVIEW_REQUIRED",
          mergeStateStatus: "BLOCKED",
        },
      });
    const status = testRuntime(reader());
    expect(
      await main([...single, "--pretty", "--status-only"], status.runtime)
    ).toBe(0);
    expect(status.stdout.join("")).toContain(
      "| [#1](https://github.com/owner/repo/pull/1) | ✅ | 👀 review required | ⛔ blocked |"
    );
    const watch = testRuntime(reader());
    expect(await main([...single, "--pretty"], watch.runtime)).toBe(6);
    expect(watch.stdout.join("")).toBe(
      "BLOCKER: review-required\npr=1\naction=get the required approving review\n"
    );
  });
});

describe("fast-path check mapping", () => {
  // gh's aggregate.go files every state it does not name into the pending
  // bucket, including completed conclusions.
  it("fails completed conclusions that gh buckets as pending", () => {
    for (const state of ["STARTUP_FAILURE", "STALE"]) {
      expect(
        parseFastCheck({ name: "ci", state, bucket: "pending" })
      ).toMatchObject({
        kind: "failed",
        reportedState: state,
      });
    }
  });

  it("keeps in-flight states pending", () => {
    for (const state of [
      "EXPECTED",
      "REQUESTED",
      "WAITING",
      "QUEUED",
      "PENDING",
      "IN_PROGRESS",
    ]) {
      expect(
        parseFastCheck({ name: "ci", state, bucket: "pending" })
      ).toMatchObject({
        kind: "pending",
        reportedState: state,
      });
    }
  });

  it("stops at a stale check instead of waiting on it", async () => {
    const stale = parseFastCheck({
      name: "ci",
      state: "STALE",
      bucket: "pending",
    });
    const watch = testRuntime(
      fakeReader({
        fastPath: { kind: "checks", checks: [passingCheck("lint"), stale] },
      })
    );
    expect(await main(single, watch.runtime)).toBe(4);
    expect(JSON.parse(watch.stdout[0])).toMatchObject({
      kind: "BLOCKER",
      blocker: {
        kind: "failing-checks",
        ci: { failed: [{ name: "ci", reportedState: "STALE" }] },
      },
    });
  });
});

describe("checks with none configured", () => {
  it("reads no checks when gh reports none and the head commit has no rollup", async () => {
    const reader = fakeReader({
      fastPath: { kind: "none-reported" },
      rollupPages: [{ kind: "no-rollup" }],
    });
    expect(await resolveChecks(reader, context(42))).toEqual({
      source: "none",
      checks: [],
    });
    expect(reader.calls).toEqual(["checksFastPath", "checkRollupPage:null"]);
  });

  it("fails closed when only one read says there are no checks", async () => {
    const oneSided = [
      {
        fastPath: { kind: "unusable", exitCode: 1, stderr: "HTTP 401" },
        rollupPages: [{ kind: "no-rollup" }],
      },
      {
        fastPath: { kind: "checks", checks: [] },
        rollupPages: [{ kind: "no-rollup" }],
      },
      {
        fastPath: { kind: "none-reported" },
        rollupPages: [{ checks: [], endCursor: null }],
      },
    ] as const;
    for (const options of oneSided)
      await expect(
        resolveChecks(fakeReader(options), context(42))
      ).rejects.toBeInstanceOf(ChecksUnavailable);
  });

  it("propagates a failed rollup query instead of reading it as no checks", async () => {
    const reader = fakeReader({ fastPath: { kind: "none-reported" } });
    const failure = new WatcherQueryError({
      kind: "command-exit",
      retryable: true,
      code: 1,
      detail: "HTTP 502",
    });
    reader.checkRollupPage = async () => {
      throw failure;
    };
    await expect(resolveChecks(reader, context(42))).rejects.toBe(failure);
  });
});

describe("a PR with no checks configured", () => {
  const noChecks = {
    fastPath: { kind: "none-reported" },
    rollupPages: [{ kind: "no-rollup" }],
    commitRollups: [{ oid: "head", state: null }],
  } as const;
  const read = (overrides: Parameters<typeof fakeReader>[0] = {}) =>
    readSnapshot({
      reader: fakeReader({ ...noChecks, ...overrides }),
      context: context(30),
      pendingHistory: "omit",
      allowDraft: false,
    });

  it("is ready when GitHub reports it mergeable", async () => {
    const snapshot = await read({ facts: { reviewDecision: null } });
    expect(classifyPr(snapshot)).toMatchObject({
      kind: "ready",
      pr: { proof: { ci: { kind: "ci-none" } } },
    });
  });

  it("still stops on conflicts, review threads, and merge gates", async () => {
    const thread = {
      id: "thread",
      firstComment: null,
      isBugbot: false,
      bugbotReviewPasses: 0,
    };
    const cases = [
      [{ facts: { mergeable: "CONFLICTING" } }, { kind: "merge-conflicts" }],
      [{ threads: [thread] }, { kind: "review-threads" }],
      [
        { facts: { reviewDecision: "REVIEW_REQUIRED" } },
        { kind: "merge-gate", reason: "review-required" },
      ],
      [
        { facts: { mergeStateStatus: "BLOCKED" } },
        { kind: "merge-gate", reason: "merge-blocked" },
      ],
      [
        { facts: { isDraft: true } },
        { kind: "merge-gate", reason: "draft-pr" },
      ],
    ] as const;
    for (const [overrides, blocker] of cases)
      expect(classifyPr(await read(overrides))).toMatchObject({
        kind: "blocker",
        blocker,
      });
  });

  it("fails closed while the head may not have reported yet", async () => {
    const unsettled = [
      {
        commitRollups: [
          { oid: "earlier", state: "SUCCESS" },
          { oid: "head", state: null },
        ],
      },
      { commitRollups: [{ oid: "head", state: "PENDING" }] },
      { facts: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } },
    ] as const;
    for (const overrides of unsettled)
      await expect(read(overrides)).rejects.toMatchObject({
        failure: { kind: "checks-unavailable", retryable: true },
      });
  });

  it("names the absence of checks in the status table and the READY verdict", async () => {
    const reader = () =>
      fakeReader({ ...noChecks, facts: { reviewDecision: null } });
    const status = testRuntime(reader());
    expect(
      await main([...single, "--pretty", "--status-only"], status.runtime)
    ).toBe(0);
    expect(status.stdout.join("")).toContain(
      "| [#1](https://github.com/owner/repo/pull/1) | ➖ no checks | ✅ | ✅ |"
    );
    const ready = testRuntime(reader());
    expect(await main([...single, "--pretty"], ready.runtime)).toBe(0);
    expect(ready.stdout.join("")).toBe(
      "READY: no merge conflicts, no unresolved review threads, no failing or pending checks\nmergeStateStatus=CLEAN\nreviewDecision=null\nisDraft=false\nchecks=none reported on the head commit\n"
    );
  });
});

// These replay through the real gh reader what gh returned for a mergeable PR
// in a repository with no checks configured: `gh pr checks` exits 1 with "no
// checks reported" and the head commit's statusCheckRollup is null.
describe("the gh reader on a repository with no checks configured", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const dir of directories.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function run(scenario: string, extra: readonly string[]) {
    const dir = mkdtempSync(join(tmpdir(), "watch-no-ci-"));
    directories.push(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}
const args = process.argv.slice(2);
const scenario = process.env.WATCH_FIXTURE;
const fail = (stderr) => { console.error(stderr); process.exit(1); };
const graphql = (name) => args.some((a) => a.includes('query ' + name));
const commits = (commit) => ({ data: { repository: { pullRequest: { commits: { nodes: [{ commit }] } } } } });
let value;
if (args[0] === 'pr' && args[1] === 'view') {
  value = { mergeable: 'MERGEABLE', mergeStateStatus: scenario === 'blocked' ? 'BLOCKED' : 'CLEAN', reviewDecision: '', headRefOid: 'head', headRefName: 'feature', baseRefName: 'main', state: 'OPEN', mergedAt: null, isDraft: false };
} else if (args[0] === 'pr' && args[1] === 'checks') {
  if (scenario === 'unauthorized') fail('HTTP 401: Bad credentials (https://api.github.com/graphql)');
  fail("no checks reported on the 'feature' branch");
} else if (graphql('PrCheckRollup')) {
  if (scenario === 'rollup-fails') fail('HTTP 502: Bad Gateway (https://api.github.com/graphql)');
  value = commits({ statusCheckRollup: null });
} else if (graphql('PrCommitStatuses')) {
  value = commits({ oid: 'head', statusCheckRollup: null });
} else if (graphql('ReviewThreads')) {
  value = { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
} else {
  fail('unexpected fixture command: ' + JSON.stringify(args));
}
console.log(JSON.stringify(value));
`
    );
    chmodSync(gh, 0o755);
    const entry = join(dir, "entry.ts");
    writeFileSync(
      entry,
      `import { main } from ${JSON.stringify(join(import.meta.dir, "cli.ts"))}; process.exitCode = await main(process.argv.slice(2));\n`
    );
    const result = spawnSync(
      process.execPath,
      [entry, ...single, "--max-query-errors", "1", ...extra],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: `${bin}:${process.env.PATH}`, WATCH_FIXTURE: scenario },
      }
    );
    return {
      status: result.status,
      verdict: JSON.parse(result.stdout.trim()) as unknown,
    };
  }

  it("finishes a status-only pass", () => {
    expect(run("clean", ["--status-only"])).toMatchObject({
      status: 0,
      verdict: {
        kind: "STATUS",
        terminal: true,
        rows: [{ kind: "open", ci: { kind: "ci-none" } }],
      },
    });
  });

  it("reports a clean PR as READY", () => {
    expect(run("clean", [])).toMatchObject({
      status: 0,
      verdict: {
        kind: "READY",
        scope: { pr: { kind: "ready-pr", proof: { ci: { kind: "ci-none" } } } },
      },
    });
  });

  it("stops at the merge gate when GitHub blocks the PR", () => {
    expect(run("blocked", [])).toMatchObject({
      status: 6,
      verdict: {
        kind: "BLOCKER",
        blocker: { kind: "merge-gate", reason: "merge-blocked" },
      },
    });
  });

  it("fails closed when a check query fails instead of reporting no checks", () => {
    for (const scenario of ["unauthorized", "rollup-fails"])
      expect(run(scenario, ["--status-only"])).toMatchObject({
        status: 7,
        verdict: { kind: "BLOCKER", blocker: { kind: "status-query" } },
      });
  });
});
