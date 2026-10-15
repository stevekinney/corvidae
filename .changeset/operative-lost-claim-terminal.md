---
'@lostgradient/operative': patch
---

A durable run whose `workflow-lease` claim another engine took no longer fires its terminal lifecycle when `handle.result()` settles with that engine's outcome. Before this, a holder whose renewal starved on a loaded host and the engine that reclaimed the run both published `run.completed`. The run stays write-free and its `closed()` reports `unresolved`/`unreachable`, as it already did for a lost checkpoint race.
