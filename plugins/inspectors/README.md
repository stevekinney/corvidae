# @lostgradient/plugin-inspectors

An Interborough plugin that contributes two interface panels, MCP apps the host builds at startup and serves as `ui://` resources.

| Panel | Resource | Linked tool | What it shows |
| --- | --- | --- | --- |
| `inspectors:run-inspector` | `ui://bureau/run-inspector/v1` | `bureau.tasks.inspect` | One task's liveness, ownership tree, progress, result, and abort. It also reads `bureau.tasks.events` and aborts through `bureau.tasks.cancel`. |
| `inspectors:pending-review` | `ui://bureau/pending-review/v1` | `bureau.reviews.list` | The caller's pending reviews: approve, deny, or reject with feedback. It also reads `bureau.reviews.get` and decides through `bureau.reviews.resolve`. |

Each panel names a browser entry (`src/run-inspector/app.ts`, `src/pending-review/app.ts`) rather than a built page. The host bundles the entry and the plugin's `styles` into one self-contained document with the script inline, and serves it under a content security policy that denies every origin and permission. The version is part of each URI: a changed contract is a new one. `allowedTools` lists the tool each panel is linked to, which is also the tool a client runs to open it.

The page models (`model.ts`) and renderers (`render.ts`) are plain DOM code with their own tests, so a panel's behavior is checked without a host. The Playwright specs that load the built pages in a sandboxed frame live in `applications/interborough/tests/mcp-apps`.

`src/plugin.test.ts` runs the plugin conformance suite. Refresh the committed identities after a schema change with `bun scripts/check-plugin-identities.ts --write plugins/inspectors`.
