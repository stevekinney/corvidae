# Workflow Visibility Backfill

Weft keeps workflow visibility indexes (`wf-idx-*` rows) so filtered `engine.list()` and `engine.aggregate()` calls can narrow their candidates instead of scanning every workflow. The indexes are opt-in by watermark: `engine.list()` and `engine.aggregate()` consult them only after the backfill has recorded a watermark that says the index is current. Until then they use the slower full-scan path, and the engine does not write index rows at all.

The backfill script builds the index rows for every existing workflow. When the scan finishes without racing writes, it records the watermark, and from that point the engine maintains the indexes on every workflow state write.

> [!WARNING] Run this from a maintenance window. Any writer that bypasses the engine's visibility-index update path can leave a workflow un-indexed below the backfill cursor while the watermark later claims the database is fully covered.

## When the engine writes index rows

A state write maintains the index rows only when one of these holds:

- The watermark is current, so the indexes are live and must stay exact.
- The engine runs with `ownership: 'workflow-lease'`. Its reclaim scan reads the `running` status index regardless of the watermark.
- The engine was created with `maintainWorkflowVisibilityIndexes: true`. This is fixed for the engine's lifetime, so it can't change between assembling a write and committing it.

Every other write skips the indexes. A fresh database therefore pays nothing for them until you run the backfill.

Engines cache the watermark for at most one second. Both the backfill and `--drop` remove the watermark first, then wait two seconds before touching any rows. After that wait, no running engine still trusts rows that are about to be cleared.

Only one backfill runs at a time. A run claims `wf-idx-meta:building` before it does anything else and releases it when it returns. A second run started while the first holds it exits with code `4`.

## When to run it

Run the backfill when you want the indexed fast path for filtered `engine.list()` and `engine.aggregate()` calls, or when a `'workflow-lease'` deployment predates the indexes and you want to stop its reclaim scan from falling back to reading workflow records.

You do not need this script for browser storage, because it instantiates `BunSQLiteStorage` directly and expects a SQLite database file.

## Before running

The backfill scans each workflow once. A workflow that changes after the scan passed it stays exact only if the write that changed it also wrote its index rows.

An engine can keep running during the backfill only if it was created with `maintainWorkflowVisibilityIndexes: true` or `ownership: 'workflow-lease'`. An engine without either skips index rows until it observes the new watermark, so a change it commits during the run leaves that workflow under stale index rows. Once the watermark is current, every engine maintains the indexes and the option no longer changes anything.

Pause every other path that can write workflow state or write directly to Weft storage:

- Weft engine processes that can start, update, signal, cancel, time out, recover, or complete workflows.
- Import scripts that create or mutate workflow records.
- Repair tooling that edits workflow state, checkpoints, search attributes, tags, deadlines, archives, or operation keys.
- Custom storage-layer write paths that call `put`, `delete`, `batch`, `conditionalBatch`, `deletePrefix`, or raw SQL against the Weft key-value table.
- Direct database jobs, migrations, or maintenance scripts that touch `wf:*`, `wf-idx-*`, `attr:*`, `idx:*`, `tag:*`, or related workflow visibility keys.

The engine's normal write path is safe because it updates visibility indexes together with workflow state whenever the indexes are live, or whenever the engine runs with the option above. The dangerous case is a foreign write path that changes a workflow below the current cursor without also maintaining its index rows.

## Run the backfill

Use the production SQLite database path:

```bash
bun scripts/rebuild-workflow-visibility-indexes.ts --storage /var/lib/weft/weft.db
```

A run that starts without a saved cursor first clears every existing `wf-idx-*` row. Engines skip index writes while the watermark is stale, so rows left from before that point can be stale or orphaned; the scan rebuilds all of them from the workflow records.

### Upgrading from index layout version 1

Layout version 2 stopped writing a per-workflow `wf-idx-manifest:` row and keys the `wf-idx-updated:` index by the minute containing `updatedAt` instead of the exact millisecond. An engine at version 2 treats a version-1 watermark as stale, so `engine.list()` and `engine.aggregate()` use the full-scan path until you run the backfill again. That run rebuilds from empty and removes the version-1 rows. A cursor that an interrupted version-1 run saved is discarded rather than resumed, because resuming would keep the version-1 rows below it.

With `--verbose`, `--batch-size` controls how often the script reports progress. It does not change storage commit size or resume granularity; the cursor is written after each processed workflow.

```bash
bun scripts/rebuild-workflow-visibility-indexes.ts --storage /var/lib/weft/weft.db --batch-size 250
```

Add `--verbose` when you need progress logs for a long maintenance window:

```bash
bun scripts/rebuild-workflow-visibility-indexes.ts --storage /var/lib/weft/weft.db --verbose
```

A successful run prints:

```text
Backfill complete. Processed <count> workflows. Watermark advanced.
```

After that message, restart the paused engines.

Only resume a paused foreign write path if it now uses the engine write path or maintains the same visibility-index contract as the engine. A direct storage writer that still changes workflow state without updating the `wf-idx-*` rows remains unsafe after the watermark exists, because visibility queries will trust the index.

## Exit codes

| Exit code | Meaning | Operator action |
| --- | --- | --- |
| `1` | Fatal usage or runtime error | Fix the reported problem, such as a missing `--storage` value or an unexpected exception, then run the command again. |
| `2` | Backend lacks `conditionalBatch` | Use the Bun SQLite storage file targeted by this script. The backfill refuses unsafe backends because racing writes could leave workflows un-indexed. |
| `3` | Conditional conflicts occurred | Keep writers paused, run `--drop`, then run the backfill again from the beginning. A conflict means the script skipped at least one workflow that changed during the scan. |
| `4` | Another backfill holds the lock | Wait for the other run to finish. A `--drop` in progress also holds the lock. If no other run is alive, a killed run left the lock behind; run `--drop`, then start the backfill again. A run whose lock a `--drop` took over also exits with `4` and stops writing at its next batch, without publishing a watermark. A `--drop` that a second `--drop` took over exits with `4` the same way. |

Exit code `3` is retryable, but do not retry against the saved cursor. A conflicted workflow may be below that cursor, so reset the visibility-index state first:

```bash
bun scripts/rebuild-workflow-visibility-indexes.ts --storage /var/lib/weft/weft.db --drop
bun scripts/rebuild-workflow-visibility-indexes.ts --storage /var/lib/weft/weft.db
```

Only treat the rollout as complete after the follow-up backfill exits with code `0` and prints `Watermark advanced`.

## Roll back the index

If you need to force the engine back to the slow visibility path, drop the generated index rows and watermark:

```bash
bun scripts/rebuild-workflow-visibility-indexes.ts --storage /var/lib/weft/weft.db --drop
```

The drop order is intentional:

- The drop takes the backfill lock and holds it until the end, so no backfill can start and publish a watermark over rows it hasn't swept yet. Taking the lock replaces any lock a killed run left behind.
- The watermark is removed next, so engines stop trusting the index once their cached watermark expires.
- The script waits for running engines to observe that.
- The `wf-idx-*` rows are swept after the wait.
- The cursor is cleared, and then the lock is released.

That ordering avoids the unsafe window where an engine sees a current watermark but the indexed rows are missing or partially deleted. An engine that still writes index rows after the drop, under `workflow-lease` or the option, only leaves rows the next backfill clears before it rebuilds.

## Verify the rollout

Before restarting production writers, confirm the command exited with code `0` and printed `Watermark advanced`.

After restart, exercise the visibility paths your operators depend on:

- List workflows with the filters used by dashboards or operations scripts.
- Run representative aggregate queries.
- Check application logs for `WorkflowListScanCapExceededError`; that error means the query had to fall back to scanning and still exceeded the configured cap.

If a verification query looks incomplete, pause writers again, run `--drop`, re-run the backfill, and only then restart engines.
