// Where the plugin lives in the repo, how its hooks files are pinned, and the
// Markdown code spans the generator and the runtime table render identifiers
// with. The installer imports this file, so it imports only Node.
import { createHash } from "node:crypto";

export const PLUGIN = "plugins/pstack";
export const SKILLS = `${PLUGIN}/skills`;

// Each hooks file's digest and the release that last changed it. A hooks
// file's digest ignores its formatting.
export const FROZEN_HOOKS = "tools/frozen-hooks.json";
export const hookDigest = (text) => createHash("sha256").update(JSON.stringify(JSON.parse(text))).digest("hex");

export const code = (s) => `\`${s}\``;
export const codeList = (models) => models.map(code).join(", ");
