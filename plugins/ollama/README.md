# @lostgradient/plugin-ollama

An Interborough plugin that contributes one embedder, `ollama:embed`, backed by an Ollama server. Governed memory embeds with the built-in hashing embedder until the owner sets `memory.embedder` to `ollama:embed`; enabling the plugin never changes memory on its own, and the switch re-embeds stored memories in the background.

| Setting | Default | What it is |
| --- | --- | --- |
| `model` | `nomic-embed-text` | The Ollama embedding model. |
| `dimensions` | `768` | How many numbers the model returns per text. A response that holds another number fails and names this setting. |
| `baseURL` | `http://localhost:11434` | The server's base URL; the plugin posts to `/api/embed` beneath it. |

The plugin declares no secret, so its embedder is available whenever the plugin runs. A server that is not running fails the embedding call, and the switch with it.

`src/plugin.test.ts` runs the plugin conformance suite and calls the embedder against a `Bun.serve` fake. Refresh the committed identities after a schema change with `bun scripts/check-plugin-identities.ts --write plugins/ollama`.
