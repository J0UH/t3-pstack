// Proves each static layout invariant still fails when it should. A check
// that quietly matches nothing looks identical to a pass, so every check gets
// a fixture that must trip it.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentSkills, validatePluginLayout } from "../tools/generate.mjs";

function skill(root, name, front, body = "body\n") {
  mkdirSync(join(root, "skills", name), { recursive: true });
  writeFileSync(
    join(root, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture\n${front}---\n\n${body}`,
  );
}

const fixtures = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function plugin(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "invariants-"));
  fixtures.push(root);
  skill(root, "poteto-mode", "");
  skill(root, "tdd", "disable-model-invocation: true\n");
  mutate(root);
  return root;
}

const check = (root) => {
  agentSkills(join(root, "skills"));
  validatePluginLayout(root);
};

describe("static plugin invariants", () => {
  test("a clean tree passes, with upstream's manual-only flag on every skill but poteto-mode", () => {
    expect(() => check(plugin())).not.toThrow();
  });

  test("a commands/ directory fails", () => {
    const root = plugin((r) => mkdirSync(join(r, "commands"), { recursive: true }));
    expect(() => check(root)).toThrow("plugins/pstack/commands/ exists");
  });

  test("an Agent Plugins root manifest fails", () => {
    const root = plugin((r) => writeFileSync(join(r, "plugin.json"), "{}\n"));
    expect(() => check(root)).toThrow("plugins/pstack/plugin.json exists; Codex would truncate every injected SKILL.md");
  });

  test("disable-model-invocation on poteto-mode fails and names the file", () => {
    const root = plugin((r) => skill(r, "poteto-mode", "disable-model-invocation: true\n"));
    expect(() => check(root)).toThrow(
      /skills\/poteto-mode\/SKILL\.md: disable-model-invocation: true stops the session-start hook from invoking poteto-mode/,
    );
  });

  test("a tree without poteto-mode fails", () => {
    const root = plugin((r) => rmSync(join(r, "skills", "poteto-mode"), { recursive: true }));
    expect(() => check(root)).toThrow("plugins/pstack/skills has no poteto-mode skill");
  });

  test("a skill whose name is not its directory fails", () => {
    const root = plugin((r) => {
      skill(r, "how", "");
      writeFileSync(join(r, "skills/how/SKILL.md"), "---\nname: How\ndescription: fixture\n---\n");
    });
    expect(() => check(root)).toThrow('frontmatter name "How" != directory "how"');
  });

  test("an unresolved sync conflict in any plugin file fails and names each marker line", () => {
    const root = plugin((r) => {
      mkdirSync(join(r, "skills/tdd/scripts"), { recursive: true });
      writeFileSync(
        join(r, "skills/tdd/scripts/run.sh"),
        "echo\n<<<<<<< local\necho port\n||||||| base\necho\n=======\necho upstream\n>>>>>>> upstream\n",
      );
    });
    expect(() => check(root)).toThrow(
      /skills\/tdd\/scripts\/run\.sh:2: <<<<<<< local\n.*run\.sh:4: \|{7} base\n.*run\.sh:6: =======\n.*run\.sh:8: >>>>>>> upstream/,
    );
  });

  test("the body of poteto-mode may mention the flag in prose", () => {
    const root = plugin();
    writeFileSync(
      join(root, "skills/poteto-mode/SKILL.md"),
      "---\nname: poteto-mode\ndescription: fixture\n---\n\nNever set disable-model-invocation: true on this skill.\n",
    );
    expect(() => check(root)).not.toThrow();
  });
});
