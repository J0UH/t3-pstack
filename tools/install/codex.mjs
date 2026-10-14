// Codex: the marketplace plugin in one CODEX_HOME, and trust for its hook.
// Codex runs a plugin hook only once `hooks.state."<key>".trusted_hash` in
// config.toml matches the hook's entry. Its TUI asks for that trust, but
// `codex app-server`, which T3 runs, never does. So the installer trusts the
// hook the way the TUI does, through the app-server, with the hash Codex
// reports, on every install and update.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { check, INSTALL_HINT, MARKETPLACE, neutralCwd, PLUGIN_ID, runCli } from "./common.mjs";

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
    this.proc = spawn(home.bin, ["app-server"], {
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
        const message = line ? JSON.parse(line) : {};
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

  close() {
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
function installedVersions(dir) {
  const cache = join(dir, "plugins/cache", MARKETPLACE, PLUGIN_ID.split("@")[0]);
  return existsSync(cache) ? readdirSync(cache).filter((name) => !name.startsWith(".")) : [];
}

async function pluginState(server, dir) {
  const { marketplaces = [] } = await server.request("plugin/list", {});
  const plugin = marketplaces.flatMap((m) => m.plugins ?? []).find((p) => p.id === PLUGIN_ID);
  return { installed: plugin?.installed === true, enabled: plugin?.enabled === true, versions: installedVersions(dir) };
}

async function pluginHooks(server) {
  const { data } = await server.request("hooks/list", {});
  return data.flatMap((entry) => entry.hooks).filter((hook) => hook.pluginId === PLUGIN_ID);
}

const current = (state, version) => state.installed && state.enabled && state.versions.join() === version;

export async function installCodex(home, { source, version, localSource }) {
  const steps = [];
  const plugin = (...args) => runCli(home.bin, ["plugin", ...args], { CODEX_HOME: home.dir });
  mkdirSync(home.dir, { recursive: true });
  if (!/^t3-pstack\s/m.test(plugin("marketplace", "list"))) {
    plugin("marketplace", "add", source);
    steps.push(`added the ${MARKETPLACE} marketplace from ${source}`);
  }
  const before = await withServer(home, (server) => pluginState(server, home.dir));
  if (!current(before, version)) {
    // A local marketplace is read in place; a Git one is a snapshot to refresh.
    if (!localSource) plugin("marketplace", "upgrade", MARKETPLACE);
    plugin("add", PLUGIN_ID);
    const after = installedVersions(home.dir).join(", ");
    steps.push(before.versions.length ? `updated ${before.versions.join(", ")} to ${after}` : `installed ${after}`);
  }
  steps.push(...(await withServer(home, trustHooks)));
  return steps;
}

// `upsert`: `replace` would drop the user's other trusted hooks.
async function trustHooks(server) {
  const pending = (await pluginHooks(server)).filter((h) => h.trustStatus === "untrusted" || h.trustStatus === "modified");
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

export async function doctorCodex(home, { version, skills }) {
  return withServer(home, async (server) => {
    const state = await pluginState(server, home.dir);
    const hooks = await pluginHooks(server);
    const listed = (await server.request("skills/list", { cwds: [neutralCwd()] })).data.flatMap((entry) => entry.skills);
    const ours = new Set(skills);
    const plain = listed.filter((skill) => ours.has(skill.name)).map((skill) => skill.path);
    const installed = state.versions.join(", ");
    const untrusted = hooks.filter((h) => h.trustStatus !== "trusted");
    return [
      check(
        "installed",
        state.installed && installed === version,
        state.installed ? `${installed}${installed === version ? "" : `, expected ${version}`}` : "not installed",
        INSTALL_HINT,
      ),
      check("enabled", state.enabled, state.enabled ? "yes" : "no", INSTALL_HINT),
      check(
        "session-start hook trusted",
        hooks.length > 0 && untrusted.length === 0,
        hooks.length ? hooks.map((h) => `${h.key} ${h.trustStatus}`).join("; ") : "no t3-pstack hook listed",
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
