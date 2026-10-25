import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CODEX_SKILL_POLICY, plan } from "../tools/generate.mjs";
import { SKILLS } from "../tools/plugin.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("Codex skill policy", () => {
  test("every skill starts in Codex only when the user names it", () => {
    const { files } = plan(repoRoot);
    const skills = readdirSync(join(repoRoot, SKILLS)).filter((name) => existsSync(join(repoRoot, SKILLS, name, "SKILL.md")));
    expect(skills.length).toBeGreaterThan(0);
    for (const name of skills) expect(files[`${SKILLS}/${name}/agents/openai.yaml`]).toBe(CODEX_SKILL_POLICY);
  });

  test("the policy turns implicit invocation off", () => {
    expect(CODEX_SKILL_POLICY).toBe("policy:\n  allow_implicit_invocation: false\n");
  });
});
