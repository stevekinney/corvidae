# @lostgradient/plugin-anthropic

An Interborough plugin that contributes the Anthropic model provider (`anthropicProvider` from `@lostgradient/operative-anthropic`) and its catalog rows, which Operative ships with the provider. The host builds its model catalog from the providers the loaded plugins contribute, so an Anthropic model reaches an agent only while this plugin is enabled and its key is set.

| Setting | Default | What it is |
| --- | --- | --- |
| `models` | every current model | An optional allowlist, each entry a model or one of its aliases. The host reads it from `plugins.anthropic.configuration.models` on every catalog load, so a change applies without a restart. An entry that matches no current model fails startup and names the field. |

The plugin declares the Bungalow secret `anthropic-api-key`, the key the host has always used. Until it is saved the plugin is `needs-setup` and the host offers none of its models.

`src/plugin.test.ts` runs the plugin conformance suite. Refresh the committed identities after a schema change with `bun scripts/check-plugin-identities.ts --write plugins/anthropic`.
