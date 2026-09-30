# Workflow Visibility Backfill

Weft keeps workflow visibility indexes (`wf-idx-*` rows) so filtered `engine.list()` and `engine.aggregate()` calls can narrow their candidates instead of scanning every workflow. The indexes are opt-in by watermark: `engine.list()` and `engine.aggregate()` consult them only after the backfill has recorded a watermark that says the index is current. Until then they use the slower full-scan path, and the engine does not write index rows at all.

The backfill script builds the index rows for every existing workflow. When the scan finishes without racing writes, it records the watermark, and from that point the engine maintains the indexes on every workflow state write.

> [!WARNING] Run this from a maintenance window. Any writer that bypasses the engine's visibility-index update path can leave a workflow un-indexed below the backfill cursor while the watermark later claims the database is fully covered.

## When the engine writes index rows

A state write maintains the index rows only when one of these holds:

- The watermark is current, so the indexes are live and must stay exact.
- A backfill is running. The script writes `wf-idx-meta:building` before it scans, so a workflow that changes or appears after the cursor passed it is indexed by the write that produced it.
- The engine runs with `ownership: 'workflow-lease'`. Its reclaim scan reads the `running` status index regardless of the watermark.

Every other write skips the indexes. A fresh database therefore pays nothing for them until you run the backfill. Engines re-read the watermark and the marker at most once per second, so the script waits two seconds after writing the marker (and after removing the watermark in `--drop`) before it touches any rows. That wait is what lets an engine that was still running observe the change.

## When to run it

Run the backfill when you want the indexed fast path for filtered `engine.list()` and `engine.aggregate()` calls, or when a `'workflow-lease'` deployment predates the indexes and you want to stop its reclaim scan from falling back to reading workflow records.

You do not need this script for browser storage, because it instantiates `BunSQLiteStorage` directly and expects a SQLite database file.

## Before running

Pause every path that can write workflow state or write directly to Weft storage:

- Weft engine processes that can start, update, signal, cancel, time out, recover, or complete workflows.
- Import scripts that create or mutate workflow records.
- Repair tooling that edits workflow state, checkpoints, search attributes, tags, deadlines, archives, or operation keys.
- Custom storage-layer write paths that call `put`, `delete`, `batch`, `conditionalBatch`, `deletePrefix`, or raw SQL against the Weft key-value table.
- Direct database jobs, migrations, or maintenance scripts that touch `wf:*`, `wf-idx-*`, `attr:*`, `idx:*`, `tag:*`, or related workflow visibility keys.

The engine's normal write path is safe because it updates visibility indexes together with workflow state whenever the indexes are live. The dangerous case is a foreign write path that changes a workflow below the current cursor without also maintaining its manifest and index rows.

## Run the backfill

Use the production SQLite database path:

```bash
bun scripts/rebuild-workflow-visibility-indexes.ts --storage /var/lib/weft/weft.db
```

A run that starts without a saved cursor first clears every existing `wf-idx-*` row. Engines skip index writes while the watermark is stale, so rows left from before that point can be stale or orphaned; the scan rebuilds all of them from the workflow records.

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

Only resume a paused foreign write path if it now uses the engine write path or maintains the same visibility-index contract as the engine. A direct storage writer that still changes workflow state without updating the manifest and `wf-idx-*` rows remains unsafe after the watermark exists, because visibility queries will trust the index.

## Exit codes

| Exit code | Meaning | Operator action |
| --- | --- | --- |
| `1` | Fatal usage or runtime error | Fix the reported problem, such as a missing `--storage` value or an unexpected exception, then run the command again. |
| `2` | Backend lacks `conditionalBatch` | Use the Bun SQLite storage file targeted by this script. The backfill refuses unsafe backends because racing writes could leave workflows un-indexed. |
| `3` | Conditional conflicts occurred | Keep writers paused, run `--drop`, then run the backfill again from the beginning. A conflict means the script skipped at least one workflow that changed during the scan. |

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

- The watermark and the building marker are removed first, so the engine immediately stops trusting the index.
- The script waits for running engines to observe that they no longer need to write index rows.
- The `wf-idx-*` rows are swept after the wait.
- The cursor is cleared last.

That ordering avoids the unsafe window where the engine sees a current watermark but the indexed rows are missing or partially deleted, and it keeps an engine that had not yet noticed the drop from writing rows back behind the sweep.

## Verify the rollout

Before restarting production writers, confirm the command exited with code `0` and printed `Watermark advanced`.

After restart, exercise the visibility paths your operators depend on:

- List workflows with the filters used by dashboards or operations scripts.
- Run representative aggregate queries.
- Check application logs for `WorkflowListScanCapExceededError`; that error means the query had to fall back to scanning and still exceeded the configured cap.

If a verification query looks incomplete, pause writers again, run `--drop`, re-run the backfill, and only then restart engines.
