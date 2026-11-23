# @lostgradient/plugin-openai

An Interborough plugin that contributes the OpenAI model provider (`openaiProvider` from `@lostgradient/operative-openai`), its catalog rows, and one embedder, `openai:text-embedding-3-small` (1536 numbers per vector). The host builds its model catalog from the providers the loaded plugins contribute, so a OpenAI model reaches an agent only while this plugin is enabled and its key is set. Governed memory embeds with the built-in hashing embedder until the owner sets `memory.embedder` to `openai:text-embedding-3-small`; enabling the plugin never changes memory on its own.

| Setting | Default | What it is |
| --- | --- | --- |
| `models` | every current model | An optional allowlist, each entry a model or one of its aliases. The host reads it from `plugins.openai.configuration.models` on every catalog load, so a change applies without a restart. An empty list, or an entry that matches no current model, skips the plugin at startup with a `configuration-invalid` problem that names the field (for example `models[1]`); the host still starts, and the problem shows in the plugin's row in Settings > Plugins. |

The plugin declares the Bungalow secret `openai-api-key`, the key the host has always used. Until it is saved the plugin is `needs-setup`, the host offers none of its models, and its embedder is unavailable. The embedder reads the key each time it embeds, so saving it needs no restart.

`src/plugin.test.ts` runs the plugin conformance suite. Refresh the committed identities after a schema change with `bun scripts/check-plugin-identities.ts --write plugins/openai`.
