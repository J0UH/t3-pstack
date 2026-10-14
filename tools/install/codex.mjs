// Codex: the marketplace plugin in one CODEX_HOME, and trust for its hook.
// Codex runs a plugin hook only once `hooks.state."<key>".trusted_hash` in
// config.toml matches the hook's entry. Its TUI asks for that trust, but
// `codex app-server`, which T3 runs, never does. So the installer trusts the
// hook the way the TUI does, through the app-server, with the hash Codex
// reports, on every install and update, once its hooks file is the one
// tools/frozen-hooks.json pins.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { hookDigest } from "../plugin.mjs";
import {
  check,
  codexSource,
  INSTALL_HINT,
  isPlainCopy,
  launch,
  MARKETPLACE,
  marketplaceCheck,
  neutralCwd,
  PLUGIN_ID,
  pluginIntact,
  runCli,
  updated,
} from "./common.mjs";

const REQUEST_TIMEOUT = 60_000;

// A JSON-RPC client over `codex app-server` stdio.
export class AppServer {
  static async start(home) {
    const server = new AppServer(home);
    await server.request("initialize", { clientInfo: { name: "t3-pstack-installer", version: "1" } });
    server.proc.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    return server;
  }

  constructor(home) {
    const run = launch(home.bin, ["app-server"]);
    this.proc = spawn(run.file, run.args, {
      ...run.options,
      cwd: neutralCwd(),
      env: { ...process.env, CODEX_HOME: home.dir },
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.nextId = 0;
    this.pending = new Map();
    this.notifications = [];
    const failAll = (err) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(err);
      }
      this.pending.clear();
    };
    this.proc.on("error", failAll);
    this.proc.stdin.on("error", failAll);
    this.proc.on("exit", (code) => failAll(new Error(`codex app-server exited with ${code}`)));
    let buffer = "";
    this.proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = line ? JSON.parse(line) : {};
        } catch {
          // Not quoted: the line could hold anything the server printed.
          failAll(new Error("codex app-server printed a line that is not JSON-RPC"));
          this.close();
          return;
        }
        if (message.method) this.notifications.push(message);
        const waiter = this.pending.get(message.id);
        if (!waiter || message.method) continue;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(`${waiter.method}: ${JSON.stringify(message.error)}`));
        else waiter.resolve(message.result);
      }
    });
  }

  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no reply from codex app-server in ${REQUEST_TIMEOUT / 1000}s`));
      }, REQUEST_TIMEOUT);
      this.pending.set(id, { resolve, reject, method, timer });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  // On Windows the process may be cmd.exe running npm's shim, and killing it
  // leaves the server it started; closing stdin ends that server too.
  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

async function withServer(home, use) {
  const server = await AppServer.start(home);
  try {
    return await use(server);
  } finally {
    server.close();
  }
}

// Codex keeps one cache directory per installed version and removes the old
// one when it installs another.
const cacheDir = (dir) => join(dir, "plugins/cache", MARKETPLACE, PLUGIN_ID.split("@")[0]);
function installedVersions(dir) {
  const cache = cacheDir(dir);
  return existsSync(cache) ? readdirSync(cache).filter((name) => !name.startsWith(".")) : [];
}

async function pluginState(server, dir, skills) {
  const { config } = await server.request("config/read", {});
  const marketplace = config.marketplaces?.[MARKETPLACE];
  const { marketplaces = [] } = await server.request("plugin/list", {});
  const plugin = marketplaces.flatMap((m) => m.plugins ?? []).find((p) => p.id === PLUGIN_ID);
  const versions = installedVersions(dir);
  return {
    sources: marketplace ? [codexSource(marketplace)] : [],
    installed: plugin?.installed === true,
    enabled: plugin?.enabled === true,
    versions,
    intact: versions.length === 1 && pluginIntact(join(cacheDir(dir), versions[0]), ".codex-plugin/plugin.json", skills),
  };
}

async function pluginHooks(server) {
  const { data } = await server.request("hooks/list", {});
  return data.flatMap((entry) => entry.hooks).filter((hook) => hook.pluginId === PLUGIN_ID);
}

// The hook's entry comes from the hooks file the Codex manifest names, with
// the digest that file is pinned at.
const isPinned = (hook, pin) =>
  hook.sourcePath.replaceAll("\\", "/").endsWith(`/${pin.path}`) &&
  existsSync(hook.sourcePath) &&
  hookDigest(readFileSync(hook.sourcePath, "utf8")) === pin.sha256;

// Why `codex plugin add` runs: a first install, an update, a cache with
// missing files, or a disabled plugin, since Codex has no enable command.
// Null when the home is already at `version`.
function codexStep(state, version) {
  if (!state.installed) return "install";
  if (state.versions.length && state.versions.join() !== version) return "update";
  if (!state.intact) return "repair";
  if (!state.enabled) return "enable";
  return null;
}

export async function installCodex(home, { source, trusted, version, skills, codexHook }) {
  const steps = [];
  const plugin = (...args) => runCli(home.bin, ["plugin", ...args], { CODEX_HOME: home.dir });
  const state = () => withServer(home, (server) => pluginState(server, home.dir, skills));
  mkdirSync(home.dir, { recursive: true });
  let before = await state();
  if (!before.sources.length) {
    plugin("marketplace", "add", source.arg);
    steps.push(`added the ${MARKETPLACE} marketplace from ${source.arg}`);
    before = await state();
  }
  // Nothing installs from a marketplace of another source; doctor names it.
  if (!marketplaceCheck(before.sources, trusted).ok) return steps;
  const step = codexStep(before, version);
  if (step) {
    // A local marketplace is read in place; a Git one is a snapshot to refresh.
    if (step !== "enable" && !source.local) plugin("marketplace", "upgrade", MARKETPLACE);
    plugin("add", PLUGIN_ID);
    const after = installedVersions(home.dir).join(", ");
    steps.push(
      {
        install: `installed ${after}`,
        update: updated(before.versions.join(", "), after, version),
        repair: `reinstalled ${after}, whose files were missing`,
        enable: "enabled it",
      }[step],
    );
  }
  steps.push(...(await withServer(home, (server) => trustHooks(server, codexHook))));
  return steps;
}

// `upsert`: `replace` would drop the user's other trusted hooks. An entry
// from any other hooks file stays untrusted, and doctor names it.
async function trustHooks(server, pin) {
  const pending = (await pluginHooks(server)).filter(
    (h) => (h.trustStatus === "untrusted" || h.trustStatus === "modified") && isPinned(h, pin),
  );
  if (!pending.length) return [];
  await server.request("config/value/write", {
    keyPath: "hooks.state",
    mergeStrategy: "upsert",
    value: Object.fromEntries(pending.map((h) => [h.key, { trusted_hash: h.currentHash }])),
  });
  const after = new Map((await pluginHooks(server)).map((h) => [h.key, h.trustStatus]));
  const failed = pending.filter((h) => after.get(h.key) !== "trusted");
  if (failed.length) throw new Error(`Codex still reports ${failed.map((h) => `${h.key} ${after.get(h.key)}`).join(", ")} after the trust write`);
  return pending.map((h) => `trusted hook ${h.key} (was ${h.trustStatus})`);
}

export async function doctorCodex(home, { version, skills, trusted, codexHook }) {
  return withServer(home, async (server) => {
    const state = await pluginState(server, home.dir, skills);
    const hooks = await pluginHooks(server);
    const listed = (await server.request("skills/list", { cwds: [neutralCwd()] })).data.flatMap((entry) => entry.skills);
    const plain = listed.filter((skill) => isPlainCopy(skill.name, skill.path, skills)).map((skill) => skill.path);
    const installed = state.versions.join(", ");
    const good = (h) => h.trustStatus === "trusted" && isPinned(h, codexHook);
    return [
      marketplaceCheck(state.sources, trusted, `remove it with \`CODEX_HOME=${home.dir} codex plugin marketplace remove ${MARKETPLACE}\``),
      check(
        "installed",
        state.installed && installed === version && state.intact,
        !state.installed
          ? "not installed"
          : state.versions.length && installed !== version
            ? `${installed}, expected ${version}`
            : state.intact
              ? installed
              : `its files in ${join(cacheDir(home.dir), installed)} are missing`,
        INSTALL_HINT,
      ),
      check("enabled", state.enabled, state.enabled ? "yes" : "no", INSTALL_HINT),
      check(
        "session-start hook trusted",
        hooks.length > 0 && hooks.every(good),
        hooks.length
          ? hooks.map((h) => `${h.key} ${h.trustStatus}${isPinned(h, codexHook) ? "" : `, not from the ${codexHook.path} this release pins`}`).join("; ")
          : "no t3-pstack hook listed",
        INSTALL_HINT,
      ),
      check(
        "no plain copies of plugin skills",
        plain.length === 0,
        plain.length ? plain.slice(0, 5).join(", ") + (plain.length > 5 ? ` and ${plain.length - 5} more` : "") : "none",
        "delete these copies, for example from ~/.agents/skills; the plugin ships the same skills",
      ),
    ];
  });
}
