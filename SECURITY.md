# Security

Report a vulnerability privately, through [GitHub's private vulnerability reporting form](https://github.com/chhoumann/t3-pstack/security/advisories/new) where the repository has it enabled, or else by contacting the maintainer through their [GitHub profile](https://github.com/chhoumann). Please do not open a public issue for a vulnerability, because the issue tracker is public from the moment you press submit. A private report keeps the details between us until a fix is released.

The skill tree, the hooks, the vendored bun scripts under `plugins/pstack/skills/poteto-mode/scripts`, and the CI workflows are all in scope. Anything that makes an agent run a command the user did not intend, exfiltrate a secret, or reach outside the repository it was pointed at counts, as does a supply-chain weakness in how this repository pins and installs its own dependencies. Findings in T3 Code, Claude Code, or Codex belong to their projects, and findings in the upstream project this repository syncs from belong upstream.

Only the latest release on `main` receives fixes. Plugin auto-update installs by version number, so a fix ships as a new release rather than as a patch to an older one, and there are no maintained release branches to back-port to.

## Threat model

The installer installs nothing and trusts no hook in a home whose `t3-pstack` marketplace comes from anywhere but `chhoumann/t3-pstack` or the run's explicit `--source`. In Codex it trusts only t3-pstack's own session-start hook, from the hooks file the Codex manifest names, at the digest `tools/frozen-hooks.json` pins. Like Codex's own hook trust, it checks the hook's entry and not the script the entry runs, which changes with each release. The marketplace source is what vouches for the script.

An attacker who can already write to the user's Claude Code or Codex home, or to the plugin cache inside it, is out of scope. That is the boundary Codex's hook trust has, since such an attacker can write `hooks.state` in `config.toml` themselves. The installer still closes the simple windows. It checks the source, lists the hooks, and writes the trust in one app-server session, reads the hooks file once and never through a symlink, and takes the trust back when the entry changes before Codex confirms it.

`npx -y github:chhoumann/t3-pstack` runs the latest commit on `main`, the rolling channel the marketplaces auto-update from. `npx -y github:chhoumann/t3-pstack#v<version>` runs one release's installer from its tag.
