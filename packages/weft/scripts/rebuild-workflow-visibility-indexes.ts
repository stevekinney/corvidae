#!/usr/bin/env bun
/**
 * Build or roll back the workflow visibility indexes laid down by
 * Phase 3 so `engine.list()` and `engine.aggregate()` can trust the
 * `wf-idx-*` rows as a query-time index.
 *
 * Usage:
 *   bun scripts/rebuild-workflow-visibility-indexes.ts --storage <path>
 *   bun scripts/rebuild-workflow-visibility-indexes.ts --storage <path> --drop
 *
 * The script operates against `BunSQLiteStorage`. Live-write race
 * policy: when `conditionalBatch` is unavailable the library refuses
 * to run; stop the engine, re-run the backfill, then restart.
 *
 * Engines write index rows only once the watermark is current, under
 * `ownership: 'workflow-lease'`, or when created with
 * `maintainWorkflowVisibilityIndexes: true`, so a database that has never been
 * backfilled carries no index rows. A run that starts without a saved cursor
 * therefore rebuilds every row from the workflow records. Both a run and
 * `--drop` wait two seconds after removing the watermark so a running engine
 * stops trusting the index, and only one run holds `wf-idx-meta:building` at a
 * time (see `scripts/lib/workflow-visibility-backfill.ts`).
 *
 * @module scripts/rebuild-workflow-visibility-indexes
 */

import { exit } from 'node:process';
import { parseArgs } from 'node:util';

import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';

import {
  WorkflowVisibilityBackfillInProgressError,
  runWorkflowVisibilityBackfill,
  runWorkflowVisibilityDrop,
} from './lib/workflow-visibility-backfill.ts';

type CliArgs = {
  storagePath: string;
  drop: boolean;
  batchSize: number;
  verbose: boolean;
};

function printUsage(): void {
  const usage = [
    'rebuild-workflow-visibility-indexes',
    '',
    'Usage:',
    '  bun scripts/rebuild-workflow-visibility-indexes.ts --storage <path>',
    '  bun scripts/rebuild-workflow-visibility-indexes.ts --storage <path> --drop',
    '',
    'Options:',
    '  --storage <path>    Required. Path to a BunSQLiteStorage database file.',
    '  --drop              Remove every wf-idx-* row plus the meta watermark.',
    '  --batch-size <n>    Conditional-batch checkpoint interval (default 500).',
    '  --verbose           Log every processed workflow id.',
    '  --help              Show this usage.',
  ];
  console.error(usage.join('\n'));
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      storage: { type: 'string' },
      drop: { type: 'boolean', default: false },
      'batch-size': { type: 'string', default: '500' },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  if (values.help || !values.storage) {
    printUsage();
    exit(values.help ? 0 : 1);
  }
  const batchSize = Math.max(1, Math.floor(Number(values['batch-size'])));
  if (!Number.isFinite(batchSize)) {
    console.error('--batch-size must be a positive integer');
    exit(1);
  }
  return {
    storagePath: values.storage,
    drop: values.drop ?? false,
    batchSize,
    verbose: values.verbose ?? false,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const storage = new BunSQLiteStorage(args.storagePath);
  try {
    if (args.drop) {
      const report = await runWorkflowVisibilityDrop(
        storage,
        args.verbose ? { logger: (message: string) => console.log(message) } : {},
      ).catch((error: unknown) => {
        if (error instanceof WorkflowVisibilityBackfillInProgressError) {
          console.error('Another --drop took over the backfill lock; let it finish.');
          exit(4);
        }
        throw error;
      });
      console.log(
        `Dropped workflow visibility indexes${args.verbose ? ` (${report.rowsDeleted} rows via fallback path)` : ''}.`,
      );
      return;
    }

    try {
      const report = await runWorkflowVisibilityBackfill(storage, {
        ...(args.verbose ? { logger: (message: string) => console.log(message) } : {}),
        checkpointEvery: args.batchSize,
      });
      if (!report.watermarkWritten) {
        console.log(
          `Backfill processed ${report.processed} workflows but saw ${report.conflicts} racing writes. Re-run to converge.`,
        );
        exit(3);
      }
      console.log(
        `Backfill complete. Processed ${report.processed} workflows. Watermark advanced.`,
      );
    } catch (error) {
      if (error instanceof WorkflowVisibilityBackfillInProgressError) {
        console.error(error.message);
        exit(4);
      }
      if (error instanceof Error && error.message.startsWith('Storage backend does not expose')) {
        console.error(
          [
            error.message,
            'Backfill cannot run while the engine is processing writes — a racing',
            'runtime update could leave a workflow un-indexed below the cursor.',
            'Stop the engine, re-run the backfill, then restart.',
          ].join('\n'),
        );
        exit(2);
      }
      throw error;
    }
  } finally {
    storage[Symbol.dispose]();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  exit(1);
});
