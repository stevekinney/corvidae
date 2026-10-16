---
'@lostgradient/weft': minor
---

The dashboard verifies worker contracts. Workers → worker detail and System → Registry → workflow detail each compare a connected worker's accepted manifest with the registry's active revision and show, as text, every workflow revision, version, or contract-hash difference and every activity the worker is missing or adds. Shared activities are confirmed when the workflow contract hash matches; when it differs, the dashboard says it cannot attribute the change and points at `weft worker verify`. Both surfaces render copyable `weft codegen --from <path> --out <file>` and `weft worker verify --manifest <path> --from <registry.json>` commands with file names derived from the worker's deployment and build and the snapshot's registry version. A failed task whose error is a strict payload-boundary rejection (`WorkerJsonValidationError`) is called out in the task ledger with the rejected path, separately from a contract mismatch.
