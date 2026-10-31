# @lostgradient/plugin-guardrails

An Interborough plugin that contributes two output guardrails, `guardrails:code-safety` and `guardrails:grounding`. Operative's default preset (the prompt-injection detector and the output PII validator, in tripwire mode) guards every agent and stays in Operative; these two add to it. An agent file lists them in its front matter:

```yaml
guardrails: [guardrails:code-safety, guardrails:grounding]
```

An agent that lists nothing still runs the default preset, and neither validator.

| Guardrail | What it flags |
| --- | --- |
| `guardrails:code-safety` | Destructive shell patterns (`rm -rf`), code execution (`eval`, `exec`, `Function`, `subprocess`), dangerous SQL (`DROP TABLE`, `DELETE FROM` without `WHERE`), and pipe-to-shell (`curl \| bash`) in a reply. |
| `guardrails:grounding` | A reply whose URLs, amounts, measurements, and quoted text mostly do not appear in the conversation so far. |

| Setting | Default | What it is |
| --- | --- | --- |
| `blockedPatterns` | `[]` | Regular expressions the code-safety validator flags in addition to its built-in patterns. |
| `groundingThreshold` | `0.8` | The share of a reply's claims that must appear in the conversation, from 0 to 1. |

The grounding validator reads the conversation through `ValidatorContext.conversationText()`, which Operative's output guardrail supplies on every step. A caller that builds the context itself and supplies no text grounds against nothing, so every claim is ungrounded.

`src/plugin.test.ts` runs the plugin conformance suite and drives agent files through a Bureau. Refresh the committed identities after a schema change with `bun scripts/check-plugin-identities.ts --write plugins/guardrails`.
