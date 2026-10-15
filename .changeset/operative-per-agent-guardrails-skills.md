---
'@lostgradient/operative': minor
---

`createAgent` accepts per-agent `guardrails` and `skills`. An agent that omits `guardrails` gets the guardrails its host passes down through `AgentRunContext.inheritedGuardrails`. With nothing inherited, it gets the AB-40 preset, now exported as `createDefaultGuardrailsPreset()`. `guardrails: false` opts the agent out. A `GuardrailsOptions` value replaces the preset. Guardrails are created fresh for each run and registered in the agent's hook tier. `skills` takes the new `AgentSkills` seam: `composeRun(run)` registers a run's skill hooks and returns its toolbox.
