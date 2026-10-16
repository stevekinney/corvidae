---
'@lostgradient/weft': minor
---

The dashboard now shows lease, attempt, and cancellation evidence. Worker detail adds a Session panel from `weft.workers.diagnostics` with the session generation, connection instant, last heartbeat, heartbeat age against a stale threshold, and health. Task ledger detail shows the session lease (`leaseDeadline`), attempt lease (`attemptDeadline`), and absolute execution deadline (`scheduleToCloseDeadline`) as three labeled clocks with exact timestamps, a fenced attempt history from `weft.tasks.get`'s `attempts` ordered by attempt and claim time, and a cancellation panel that reports worker acknowledgement only from the owning attempt's own cancelled disposition. A `weft.tasks.get` response without a valid `attempts` array, or a worker diagnostics instance without a numeric `sessionGeneration`, now renders as a malformed response.
