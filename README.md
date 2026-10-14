# t3-pstack

pstack for [T3 Code](https://github.com/pingdotgg/t3code). It is Lauren Tan's (poteto's) [pstack](https://github.com/cursor/plugins/tree/main/pstack), with its Cursor mechanics rewritten in place for T3. Every subagent, panel, fan-out, schedule, and PR watch dispatches through T3's `t3-code` MCP tools, so an `interrogate`, `arena`, or `architect` panel can run Claude, GPT, and Grok reviewers side by side, from a Claude Code thread or a Codex thread.

The skill text is Lauren's. A generated set of substitutions rewrites only what names Cursor (its `Task` tool, its model slugs, its `.mdc` rule, its cloud agents, `/loop`), and a few declared forks carry what a substitution cannot. Nothing else needs loading: the T3 rules sit where Lauren's dispatch rules sit.

t3-pstack works only inside T3.

## Install

| | Claude Code | Codex |
| --- | --- | --- |
| Plugin id | `t3-pstack@t3-pstack` | `t3-pstack@t3-pstack` |
| Marketplace repo | `chhoumann/t3-pstack` | `chhoumann/t3-pstack` |

```shell
claude plugin marketplace add chhoumann/t3-pstack && claude plugin install t3-pstack@t3-pstack
codex plugin marketplace add chhoumann/t3-pstack && codex plugin add t3-pstack@t3-pstack
```

Codex runs a plugin's session-start hook only after you trust it, through `/hooks` in the Codex CLI.

Then run `/t3-pstack:setup-pstack` in a T3 thread on each machine. It writes `t3-pstack-models.md` in the host's config directory, with one T3 target per role (`<providerInstanceId>/<modelId>` plus that provider's options), and checks it against the machine's `orchestrator_capabilities`. Without a sheet, every role runs on the defaults in its skill's Models section.

## Use

```text
Use poteto-mode to fix the search filter resetting when I change pages.
```

The session-start hook tells each new chat when to enter `poteto-mode` on its own: work that touches more than one file, a design choice, or a bug whose cause is unknown. `poteto-mode` matches the task to a playbook and opens the other skills from there. They ship as upstream ships them, invoked by `poteto-mode` or typed by you (`/t3-pstack:<name>` on Claude Code, `$t3-pstack:<name>` on Codex).

The plugin carries 61 skill directories, 24 of them `principle-*` leaves, and 4 agents.

## Staying current

This repository syncs from Lauren's tree directly, synced against upstream `ce649c0`. `tools/upstream.json` pins each component, `tools/substitutions.json` holds the rewrite rules and a denylist of Cursor terms, and `tools/forks.json` declares every file the port keeps in its own form and why. `bun tools/sync.mjs <component> <sha>` derives each upstream file through the rules, merges it three ways with the port's copy, and fails on an undeclared fork, a denylist hit, or a rule that no longer matches upstream. [CONTRIBUTING.md](CONTRIBUTING.md#the-sync-boundary) has the details.

## Data handling

t3-pstack has no server or telemetry. Anything its skills ask your agent to read, including session transcripts, goes to your model provider. Scripts run locally, and PR tools use your GitHub CLI login.

## Contributing

Bug reports, documentation fixes, and T3 improvements are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks and where your change belongs. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

t3-pstack is [MIT-licensed](LICENSE). Its T3 modifications and additions are © 2026 Christian Bager Bach Houmann. It builds on:

- [pstack](https://github.com/cursor/plugins/tree/main/pstack) in cursor/plugins, MIT, © 2026 Lauren Tan (poteto), the skill stack itself.
- [pstack-claude](https://github.com/michael-denyer/pstack-claude), MIT, © 2026 Michael Denyer, whose sync, generator, and validation tooling and transcript finder this port still uses.
- The skills imported from [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit), MIT, © 2026 Cursor. See [LICENSE-cursor-team-kit](LICENSE-cursor-team-kit).
- The skills and review agents imported from [thermos](https://github.com/cursor/plugins/tree/main/thermos), MIT, © 2026 Cursor. See [LICENSE-thermos](LICENSE-thermos).

[NOTICE.md](NOTICE.md) lists each upstream component with its source commit and license file.
