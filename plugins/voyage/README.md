# @lostgradient/plugin-voyage

An Interborough plugin that contributes one embedder, `voyage:embed`, backed by the Voyage AI Embeddings API. Governed memory embeds with the built-in hashing embedder until the owner sets `memory.embedder` to `voyage:embed`; enabling the plugin never changes memory on its own, and the switch re-embeds stored memories in the background.

| Setting | Default | What it is |
| --- | --- | --- |
| `model` | `voyage-3` | The Voyage embedding model. |
| `dimensions` | `1024` | How many numbers the model returns per text. A response that holds another number fails and names this setting. |
| `endpoint` | `https://api.voyageai.com/v1/embeddings` | The embeddings endpoint. |

The embedder records the configured `model` in the memory's embedding profile (COR-2184). Restarting with another `model` under the same `voyage:embed` is a different embedding: memory reports `embedder-unavailable` for the active profile until writing `memory.embedder` again (or the next maintenance pass) re-embeds stored memories under the new model. The plugin declares the Bungalow secret `voyage-api-key`. Until it is saved the plugin is `needs-setup` and `voyage:embed` is unavailable, so a write of `memory.embedder` naming it is refused. The key is read on every call, so saving it needs no restart.

`src/plugin.test.ts` runs the plugin conformance suite and drives a Bureau's memory through the embedder against a `Bun.serve` fake. Refresh the committed identities after a schema change with `bun scripts/check-plugin-identities.ts --write plugins/voyage`.
