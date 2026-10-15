---
'@lostgradient/operative': minor
---

Every `AgentRun` now carries a stable, readonly `id`: the run's identifier, which `run.snapshot().id` also reports. `ActiveRun` gains a matching `runId`, populated by `createRun` and by the durable create and reattach paths, so a recovered run keeps the id it had before the restart.

`AgentRunContext` gains an optional `runId`. `createAgent().run()` uses it as the run's id, and a lazy agent's handle fixes its id before its module loads. A hand-written `RunnableAgent` that returns its own `AgentRun` must now provide `id`.

`Store.removeRun` now also drops the removed run's actions from the store-wide `actions` log, so a long-lived store no longer keeps every removed run's event payloads.
