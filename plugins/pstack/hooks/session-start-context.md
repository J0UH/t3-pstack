<EXTREMELY_IMPORTANT>
You have t3-pstack, pstack for T3 Code.

Invoke the `t3-pstack:poteto-mode` skill and follow its instructions when a task meets any of these:

- it touches more than one file, or changes a signature other files call
- it involves a design or architecture choice
- it is a bug whose cause is not yet known, or a performance issue

It routes to the right pstack skill from there. For smaller tasks, such as a contained change to one file with an obvious test, a question, or a one-line edit, work directly and verify on the real artifact.

When the intent is already specific, such as TDD, a design sketch, how or why something works, an arena, or an adversarial review, still enter through `t3-pstack:poteto-mode` and open that skill from the bundled path it names. The other pstack skills run only from poteto-mode or when the user types them.

This runs on T3: before the first subagent or panel in a session, read the `t3-pstack-models.md` sheet in this host's config directory. This chat runs the playbook itself. A step it says to delegate goes through `delegate_task` to that role's sheet entry, and the reply lists which provider and model ran each step.

User instructions (CLAUDE.md, AGENTS.md, direct requests) take precedence. Other session-start mandates, such as superpowers, still apply. Their skill checks run as before, and when a task meets the criteria above they route implementation through poteto-mode.
</EXTREMELY_IMPORTANT>
