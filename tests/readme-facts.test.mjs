// Documentation states counts and the upstream pin in prose. Each is derivable from
// the tree, so this pins every occurrence to its source instead of trusting a
// hand edit to keep up.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentSkills } from "../tools/generate.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
const skills = agentSkills(join(repoRoot, "plugins/pstack/skills"));
const principles = skills.filter(({ name }) => name.startsWith("principle-")).length;
const agents = readdirSync(join(repoRoot, "plugins/pstack/agents")).filter((f) => f.endsWith(".md")).length;
const pins = JSON.parse(readFileSync(join(repoRoot, "tools/upstream.json"), "utf8")).components;

const numbersBefore = (phrase) => [...readme.matchAll(new RegExp(`(\\d+) (?:${phrase})`, "g"))].map((m) => Number(m[1]));

describe("README facts match the tree", () => {
  test("skill directory, principle leaf, and agent counts", () => {
    expect(numbersBefore("skill directories")).toEqual([skills.length]);
    expect(numbersBefore("of them `principle-\\*` leaves")).toEqual([principles]);
    expect(numbersBefore("agents")).toEqual([agents]);
  });

  test("the pinned installer command names this release's tag", () => {
    const version = readFileSync(join(repoRoot, "VERSION"), "utf8").trim();
    expect([...readme.matchAll(/npx -y github:chhoumann\/t3-pstack#v([^\s`]+)/g)].map((m) => m[1])).toEqual([version]);
  });

  test("the documented upstream pin matches every component's pin", () => {
    const named = [...readme.matchAll(/synced against upstream `([0-9a-f]+)`/g)].map((m) => m[1]);
    expect(named).toHaveLength(1);
    for (const { sha } of Object.values(pins)) expect(sha.startsWith(named[0])).toBe(true);
  });
});
