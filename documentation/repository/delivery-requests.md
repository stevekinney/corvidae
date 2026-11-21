# Delivery requests

`deliver.ts` lands only from a coordinator-approved request: a digest-pinned JSON file (`DeliveryRequest` in `scripts/chef/delivery-completion.ts`), an approval recorded against it in the execution state, and a `main.yml` run on the exact head bound to it. `scripts/chef/delivery-request.ts` writes all three and dry-runs the checks. Its header is the full usage; this file holds the reasoning.

## Prepare, then check, then deliver

- `prepare` runs once per accepted head. The branch is pushed and contains `--base` (the current `origin/main`), and the run holds the project's Linear lease (`linear.ts lease`) until `deliver.ts` finishes: the lease's execution-state authority (`project:<id>`, owner `linear:<run>`) is the request's, and `prepare` never mints one. It prints the file under the main checkout's `tmp/chef/requests/`, its sha256 digest and the run id.
- `check --file <json> --digest <sha256>` runs what `deliver.ts` runs before it merges, from a checkout that has the head fetched: the request loads, the approval and the current base, head and integration tree match, `validateDeliveryCiEvidence`, and `validateLandingEvidence`. It prints each refusal and exits 0 only when `deliver.ts` would proceed past verification. What `deliver.ts` checks after that, `check` does not: the lease, the published branch, reverts, conflicts, the merge queue, the guards, review threads and the route. A moved base is refused even for a branch route, which `deliver.ts` can accept when the new commits touch nothing the evidence covers.
- A pull request lands with `merge-gate.ts`, which has no moved-main tolerance: when `main` moves during the run, merge it into the branch, push, and prepare again.

## What the request attests

- Criteria come from Linear through `brief.ts` (`readBatchBrief`); there is no offline criteria file, because an assignment's revision, dependencies and source digests exist only on that read. An issue that links a design needs `--context`, the file `brief.ts --context` takes.
- The coordinator's acceptance is the approval `prepare` records: it adds `merge` to each assignment's consequential actions and re-digests the assignment.
- The evidence is one green `main.yml` run on the head, bound by an evidence identity. Every criterion of every member maps to the same provider obligation, the job `Root checks, scripts tests, audit` (the job with no `needs`, so its runner is assigned first). No criterion has a test of its own; a criterion's own proof stays in the worker's report.
- Members are tracked and closed on delivery by default; `--no-track`, `--no-close` and `--leave-open <ID>` change that.

## Why `prepare` dispatches before it writes

The file's digest covers the run id and the runner name, which exist only after a dispatch (a runner name belongs to a job and is empty until the job starts), while the batch plan digest and the request key do not. So `prepare` computes the plan digest and the identity, dispatches through `targeted-run.ts --verification-request --verification-plan --verification-base`, polls up to `--wait-minutes` for the run and its runner, then writes the file and the approval. Before dispatching it saves the members it built (`<operation>.pending.json`), so a retry never reads Linear again: the request key covers each issue's revision, and a new key would dispatch a second run and cancel the first.

A dispatch checks out the branch head, so the request's integration tree is the head's tree, and `deliver.ts` compares it with `git merge-tree --write-tree <base> <head>`: the branch must contain the base.

## Dead ends and cautions

- Dispatch nothing else on the branch after `prepare`: a newer dispatch on a ref cancels the bound run.
- A red or cancelled bound run cannot be replaced for the same head, because a second run with the same key is ambiguous. Push a new head and prepare again.
- `ci-evidence-run.ts` sends the same inputs through the provider's `dispatch`; use it or `prepare` for a head, never both.
- The approval is written once per operation (`delivery:<branch>:<head prefix>`); a request that differs from an approved one needs a new head.

## The report ledger

Neither `deliver.ts` nor `landing-evidence.ts` reads the report ledger (`report.ts write`, `documentation/criteria-ledger/`); the worker's stop hook and `deliver-issue.js` do. A brief written before `Brief version:` existed gets one by running `brief.ts` again for the same issues with the same flags: the version hashes each issue's current `updatedAt` and description, so write the report only when those are what the worker read. The ledger is a file in the worktree, so committing it makes a new head: commit it before `prepare`.
