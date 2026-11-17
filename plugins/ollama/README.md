# @lostgradient/plugin-ollama

An Interborough plugin that contributes one embedder, `ollama:embed`, backed by an Ollama server. Governed memory embeds with the built-in hashing embedder until the owner sets `memory.embedder` to `ollama:embed`; enabling the plugin never changes memory on its own, and the switch re-embeds stored memories in the background.

| Setting | Default | What it is |
| --- | --- | --- |
| `model` | `nomic-embed-text` | The Ollama embedding model. |
| `dimensions` | `768` | How many numbers the model returns per text. A response that holds another number fails and names this setting. |
| `baseURL` | `http://localhost:11434` | The server's base URL; the plugin posts to `/api/embed` beneath it. |

The embedder records the configured `model` in the memory's embedding profile (COR-2184). Restarting with another `model` under the same `ollama:embed` is a different embedding: memory reports `embedder-unavailable` for the active profile until writing `memory.embedder` again (or the next maintenance pass) re-embeds stored memories under the new model. The plugin declares no secret, so its embedder is available whenever the plugin runs. A server that is not running fails the embedding call, and the switch with it.

`src/plugin.test.ts` runs the plugin conformance suite and calls the embedder against a `Bun.serve` fake. Refresh the committed identities after a schema change with `bun scripts/check-plugin-identities.ts --write plugins/ollama`.
