// Every Claude Code and Codex config home the installer serves: the defaults,
// the shell's CLAUDE_CONFIG_DIR and CODEX_HOME, each claudeAgent and codex
// instance in T3's settings, enabled or not, and the homes named by flag.
// An instance's home resolves as T3 resolves it (apps/server
// Drivers/ClaudeHome.ts and Drivers/CodexHomeLayout.ts): `config.homePath`,
// else the instance's CLAUDE_CONFIG_DIR or CODEX_HOME, else the default.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const DRIVERS = { claudeAgent: "claude", codex: "codex" };
const ENV_VAR = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
const DEFAULT_HOME = { claude: ".claude", codex: ".codex" };

const expand = (path, home) => (path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);

// T3 keeps its state in `${T3CODE_HOME:-~/.t3}/userdata` (apps/server os-jank.ts and config.ts).
export function t3SettingsPath(env, home) {
  const base = env.T3CODE_HOME?.trim() ? resolve(expand(env.T3CODE_HOME.trim(), home)) : join(home, ".t3");
  return join(base, "userdata", "settings.json");
}

function readT3Settings(path) {
  try {
    return { instances: JSON.parse(readFileSync(path, "utf8")).providerInstances ?? {} };
  } catch (err) {
    return { instances: {}, error: err.code === "ENOENT" ? "not found" : err.message };
  }
}

// Returns `{ homes, settings }`. A home is `{ harness, dir, from, bin }`:
// `from` lists where it was found, and `bin` is the CLI T3 runs for it.
export function discoverHomes({ env, home, claudeHomes = [], codexHomes = [] }) {
  const homes = new Map();
  const add = (harness, dir, from, bin) => {
    const key = `${harness}\0${existsSync(dir) ? realpathSync(dir) : dir}`;
    const entry = homes.get(key) ?? { harness, dir, from: [], bin: harness };
    entry.from.push(from);
    if (bin && entry.bin === harness) entry.bin = bin;
    homes.set(key, entry);
  };

  for (const harness of ["claude", "codex"]) add(harness, join(home, DEFAULT_HOME[harness]), "default");

  const settingsPath = t3SettingsPath(env, home);
  const { instances, error } = readT3Settings(settingsPath);
  // A Codex shadow home is T3's auth overlay: its config.toml, plugins, and
  // skills are symlinks into the shared home, which is the one to install into.
  const shadows = new Set();
  for (const [id, instance] of Object.entries(instances)) {
    const harness = DRIVERS[instance.driver];
    if (!harness) continue;
    const config = instance.config ?? {};
    const instanceEnv = Object.fromEntries((instance.environment ?? []).map((v) => [v.name, v.value ?? ""]));
    if (config.shadowHomePath?.trim()) shadows.add(resolve(expand(config.shadowHomePath.trim(), home)));
    // T3 does not expand `~` in an inherited variable.
    const dir = config.homePath?.trim()
      ? resolve(expand(config.homePath.trim(), home))
      : instanceEnv[ENV_VAR[harness]]?.trim()
        ? resolve(instanceEnv[ENV_VAR[harness]].trim())
        : join(home, DEFAULT_HOME[harness]);
    const disabled = instance.enabled === false || config.enabled === false;
    add(harness, dir, `T3 instance ${id}${disabled ? " (disabled)" : ""}`, config.binaryPath?.trim());
  }

  for (const harness of ["claude", "codex"]) {
    const dir = env[ENV_VAR[harness]]?.trim();
    if (dir && !shadows.has(resolve(dir))) add(harness, resolve(dir), ENV_VAR[harness]);
  }
  for (const dir of claudeHomes) add("claude", resolve(expand(dir, home)), "--claude-home");
  for (const dir of codexHomes) add("codex", resolve(expand(dir, home)), "--codex-home");

  const counted = Object.values(instances).filter((instance) => DRIVERS[instance.driver]).length;
  return { homes: [...homes.values()], settings: { path: settingsPath, instances: counted, error } };
}
