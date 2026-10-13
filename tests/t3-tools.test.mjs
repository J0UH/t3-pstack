// t3-tools.md is port-only, but the watch-pr it hands agents is synced from
// upstream, so a merge can rename a flag the mapping still names.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const references = join(root, "plugins/pstack/skills/poteto-mode/references");
const mapping = readFileSync(join(references, "t3-tools.md"), "utf8");
const codexMapping = readFileSync(join(references, "codex-tools.md"), "utf8");
const cli = readFileSync(join(root, "plugins/pstack/skills/poteto-mode/scripts/watch-pr/cli.ts"), "utf8");

// The flags the Commander chain in parseArgs declares, from `new Command` to `program.parse`.
function declaredFlags(source) {
  const table = source.match(/new Command\("watch-pr"\)([\s\S]*?)program\.parse\(/);
  if (table === null) throw new Error("cli.ts has no watch-pr Commander option table");
  return new Set([...table[1].matchAll(/(?:\.option\(|new Option\()\s*"(--[a-z-]+)/g)].map((m) => m[1]));
}

// A command is a backticked span that runs watch-pr with arguments, after any path
// or shell prefix. A bare `watch-pr` names the tool and runs nothing.
const commands = (markdown) =>
  [...markdown.matchAll(/`([^`]*)`/g)].flatMap((m) => m[1].match(/(?<=^|[\s/])watch-pr\s.*/) ?? []);

const namedFlags = (markdown) => new Set(commands(markdown).flatMap((command) => command.match(/--[a-z-]+/g) ?? []));

describe("the T3 mapping's watch-pr commands", () => {
  test("use only flags the watcher declares", () => {
    const declared = declaredFlags(cli);
    expect([...namedFlags(mapping)].filter((flag) => !declared.has(flag))).toEqual([]);
  });

  test("include a --timeout, so the checks here cannot pass on zero commands", () => {
    expect(namedFlags(mapping)).toContain("--timeout");
  });

  // A tool call is capped at 600 seconds, and the watcher's own default is no deadline.
  // --status-only is bounded too: a head with no checks yet retries for 12 minutes.
  test("bound every run under the tool cap", () => {
    const unbounded = commands(mapping).filter((command) => {
      const seconds = Number(command.match(/--timeout[ =](\d+)(?=[\s`]|$)/)?.[1]);
      return !(seconds > 0 && seconds < 600);
    });
    expect(unbounded).toEqual([]);
  });
});

// Role labels come from the synced models.json, so a merge can rename one the mapping
// dispatches to, such as the review loop's seats or the research delegate's entry.
describe("the T3 mapping's role names", () => {
  const roles = new Set(JSON.parse(readFileSync(join(root, "plugins/pstack/models.json"), "utf8")).roles.map((r) => r.role));
  const named = [...mapping.matchAll(/`([a-z][a-z ,-]*)` (?:entry|entries|panel)\b/g)].map((m) => m[1]);

  test("name the review loop's seats, so the check below cannot pass on zero roles", () => {
    expect(named).toEqual(expect.arrayContaining(["interrogate reviewers", "feature, refactoring", "how explorer"]));
  });

  test("are all roles models.json declares", () => {
    expect(named.filter((role) => !roles.has(role))).toEqual([]);
  });
});

// The skill validator resolves only relative paths, so a moved file behind a
// `<plugin>/` path, such as reflect's Codex resolver, would leave a mapping
// pointing at nothing.
describe("the T3 and Codex mappings' plugin paths", () => {
  const paths = [mapping, codexMapping].flatMap((markdown) =>
    [...markdown.matchAll(/<plugin>\/([\w./-]+)(?=[`"\s])/g)].map((m) => m[1]),
  );

  test("include the Codex transcript resolver, so the check below cannot pass on zero paths", () => {
    expect(paths).toContain("skills/poteto-mode/scripts/resolve-codex-transcript");
  });

  test("all exist in the plugin", () => {
    expect(paths.filter((path) => !existsSync(join(root, "plugins/pstack", path)))).toEqual([]);
  });
});

// The validator drops a link's #fragment, and the T3 mapping sends a Codex
// thread's transcript step to a codex-tools.md section instead of copying it.
describe("the T3 mapping's links into codex-tools.md", () => {
  const slug = (heading) => heading.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-");
  const headings = new Set([...codexMapping.matchAll(/^#+ (.+)$/gm)].map((m) => slug(m[1])));
  const anchors = [...mapping.matchAll(/\(codex-tools\.md#([\w-]+)\)/g)].map((m) => m[1]);

  test("include the Transcripts section, so the check below cannot pass on zero links", () => {
    expect(anchors).toContain("transcripts");
  });

  test("all land on a heading", () => {
    expect(anchors.filter((anchor) => !headings.has(anchor))).toEqual([]);
  });
});
