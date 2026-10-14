import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentSkills, OWNED_DIRS, parseFrontmatter, PORTABLE_ASSETS, plan, problems } from "../tools/generate.mjs";
import { validateSkillsTree, walk } from "../tools/validate-skills.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillsDir = join(repoRoot, "plugins/pstack/skills");

describe("shared Agent Skills tree", () => {
  test("the working tree breaks no cross-file contract", () => {
    expect(problems(repoRoot)).toEqual([]);
  });

  test("walk returns a sorted listing regardless of directory order", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-walk-"));
    try {
      for (const name of ["zeta", "alpha", "mid"]) {
        mkdirSync(join(root, name));
        writeFileSync(join(root, name, "SKILL.md"), "# x\n");
      }
      expect(walk(root).map((p) => p.slice(root.length + 1))).toEqual([
        "alpha/SKILL.md",
        "mid/SKILL.md",
        "zeta/SKILL.md",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an installed node_modules under a skill is not validated", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-skills-links-"));
    const vendored = join(root, "example/scripts/node_modules/dep");
    mkdirSync(vendored, { recursive: true });
    writeFileSync(join(root, "example/SKILL.md"), "# Example\n");
    writeFileSync(join(vendored, "Readme.md"), "[docs](./docs/missing.md)\nRead `../../../../etc/passwd`.\n");

    try {
      expect(() => validateSkillsTree(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a bare-word target such as (url) is a template placeholder, not a missing file", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-skills-links-"));
    mkdirSync(join(root, "example"));
    writeFileSync(join(root, "example/SKILL.md"), "Source: [PR #123](url) / ticket ID / file:line.\n[gone](notes)\n");
    try {
      expect(() => validateSkillsTree(root)).not.toThrow();
      writeFileSync(join(root, "example/SKILL.md"), "[gone](notes.md)\n");
      expect(() => validateSkillsTree(root)).toThrow("example/SKILL.md -> notes.md (missing)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every skill the session-start routing tells the model to invoke is model-invocable", () => {
    const routing = readFileSync(join(repoRoot, "plugins/pstack/hooks/session-start-context.md"), "utf8");
    const named = [...routing.matchAll(/`t3-pstack:([a-z0-9-]+)`/g)].map((m) => m[1]);
    expect(named).toContain("poteto-mode");
    for (const name of named) {
      const { data } = parseFrontmatter(readFileSync(join(skillsDir, name, "SKILL.md"), "utf8"));
      expect(data["disable-model-invocation"], `${name} is invoked by the routing text`).not.toBe(true);
    }
  });

  // Codex 0.162.1 cuts the middle of a shell read whose output passes the
  // read's budget at 4 bytes a token, and caps a budget at the model's
  // 10000-token tool output limit. A tenth stays spare for what the call
  // prints around the file.
  test("poteto-mode fits the one Codex read that it and the routing text ask for", () => {
    const routing = readFileSync(join(repoRoot, "plugins/pstack/hooks/session-start-context.md"), "utf8");
    const skill = readFileSync(join(skillsDir, "poteto-mode", "SKILL.md"), "utf8");
    const budget = (text) => Number(text.match(/`max_output_tokens: (\d+)`/)?.[1]);
    const asked = budget(skill);
    expect(budget(routing)).toBe(asked);
    expect(asked).toBeLessThanOrEqual(10000);
    expect(Buffer.byteLength(skill)).toBeLessThanOrEqual(asked * 4 * 0.9);
  });

  test("a bare missing markdown target fails the boundary check", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-skills-links-"));
    const skill = join(root, "example");
    mkdirSync(skill);
    writeFileSync(
      join(skill, "SKILL.md"),
      "[missing](missing.md)\n[external](https://example.com/reference)\n",
    );

    try {
      expect(() => validateSkillsTree(root)).toThrow("example/SKILL.md -> missing.md (missing)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bare, dotted, and reference-style local links resolve inside the boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-skills-links-"));
    const skill = join(root, "example");
    const references = join(skill, "references");
    mkdirSync(references, { recursive: true });
    writeFileSync(join(references, "guide.md"), "# Guide\n");
    writeFileSync(
      join(skill, "SKILL.md"),
      [
        "[bare](references/guide.md)",
        "[dotted](./references/guide.md#section)",
        "[reference][guide]",
        "[external](https://example.com/reference)",
        "[guide]: references/guide.md",
        "[^note]: explanatory footnote text is not a link target",
      ].join("\n"),
    );

    try {
      expect(() => validateSkillsTree(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an escaping markdown target fails the boundary check", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-skills-links-"));
    const skill = join(root, "example");
    mkdirSync(skill);
    writeFileSync(join(skill, "SKILL.md"), "[escape](../../outside.md)\n");

    try {
      expect(() => validateSkillsTree(root)).toThrow(
        "example/SKILL.md -> ../../outside.md (escapes skills tree)",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a markdown symlink target cannot escape the boundary", () => {
    const parent = mkdtempSync(join(tmpdir(), "pstack-skills-links-"));
    const root = join(parent, "skills");
    const skill = join(root, "example");
    const outside = join(parent, "outside.md");
    mkdirSync(skill, { recursive: true });
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(skill, "linked.md"));
    writeFileSync(join(skill, "SKILL.md"), "[escape](linked.md)\n");

    try {
      expect(() => validateSkillsTree(root)).toThrow(
        "example/SKILL.md -> linked.md (escapes skills tree through symlink)",
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("the plan copies each portable asset from its source into a directory it owns", () => {
    const { files, ownedDirs } = plan(repoRoot);
    for (const { source, target } of PORTABLE_ASSETS) {
      expect(files[`plugins/pstack/skills/poteto-mode/references/licenses/${target}`]).toBe(readFileSync(join(repoRoot, source), "utf8"));
      expect(ownedDirs).toEqual(OWNED_DIRS);
      expect(dirname(`plugins/pstack/skills/poteto-mode/references/licenses/${target}`)).toBe(OWNED_DIRS[0]);
    }
  });

});

describe("agentSkills reads frontmatter as YAML", () => {
  function readSkill(name, text) {
    const root = mkdtempSync(join(tmpdir(), "pstack-frontmatter-"));
    try {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "SKILL.md"), text);
      return agentSkills(root)[0];
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("a folded block scalar description is read as its folded value", () => {
    const skill = readSkill("folded", "---\nname: folded\ndescription: >-\n  Use when\n  folding.\n---\n\nbody\n");
    expect(skill.description).toBe("Use when folding.");
  });

  test("the 1024 limit measures the parsed description, not its YAML source", () => {
    const value = "a".repeat(990) + '"'.repeat(30);
    const quoted = readSkill("quoted", `---\nname: quoted\ndescription: ${JSON.stringify(value)}\n---\n`);
    expect(quoted.description).toBe(value);
    expect(() => readSkill("long", `---\nname: long\ndescription: >-\n  ${"a".repeat(1025)}\n---\n`)).toThrow(
      "description exceeds the portable Agent Skills limit of 1024 characters",
    );
  });

  test("a CRLF file yields its name", () => {
    expect(readSkill("crlf", "---\r\nname: crlf\r\ndescription: d\r\n---\r\n\r\nbody\r\n").name).toBe("crlf");
  });
});
