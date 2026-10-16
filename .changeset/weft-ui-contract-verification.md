---
'@lostgradient/weft': minor
---

The dashboard now verifies worker contracts against the registry. Worker detail and a registry definition's detail both show a contract verification panel that compares each server-accepted worker manifest with the active registry snapshot, the same check `weft worker verify` runs: it lists extra and missing workflows and activities, revision, workflow version, and contract hash drift, and each finding's compatibility reason, as text. Beside it, copyable `weft codegen --from` and `weft worker verify --manifest --from` commands name the manifest file after the worker's deployment and build. A task ledger whose failure is a strict worker JSON rejection, such as an activity returning `undefined` or a non-finite number, now says the payload was rejected at the worker boundary and where, instead of presenting it like a contract mismatch.
