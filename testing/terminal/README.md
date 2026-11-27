# `@lostgradient/terminal-testing`

The evidence shared by every terminal verification run. The schema and the probes that serve more than one terminal workspace live here; a probe that serves one lives with its owner.

| Export | What it holds |
| --- | --- |
| `@lostgradient/terminal-testing/evidence-schema` | `assertEvidence`, `validateEvidence` and the report types that every probe, conformance run and benchmark writes against. |
| `@lostgradient/terminal-testing/evidence.schema.json` | The JSON Schema of an evidence report. Its `$id`, `https://corvidae.lostgradient.internal/terminal/evidence.schema.json`, is the schema's identity and never changes with its directory. |
| `@lostgradient/terminal-testing/browser-asset-evidence` | `validateBrowserAssetEvidence`, the check of the one local asset tuple and CSP a browser engine probe may load. |
| `@lostgradient/terminal-testing/resource-probe` | The resource probe: overflow, cleanup, throughput and latency measurements that need no PTY and no browser, so they are shared. |

The other probes sit with the workspace whose runtime they exercise:

- `packages/ventriloquist/scripts/runtime-probe.ts` runs the pipe and PTY runtime probes (`bun packages/ventriloquist/scripts/runtime-probe.ts`).
- `components/terminal/scripts/engine-probe.ts` and `components/terminal/scripts/browser-failure-regression.ts` run the browser-engine probes (`bun run test:terminal-browser` from the repository root runs the regression).

`bun run probe:resources` in this directory runs the resource probe. Each probe writes its report under `tmp/terminal-probes/` and refuses to run from a dirty probe source. [The terminal contract](../../documentation/terminal/contract.md) says what each report must show.
