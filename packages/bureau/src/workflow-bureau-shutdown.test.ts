/**
 * COR-1527 — shutting a Bureau down waits for the workflow files being applied to the engine, so
 * nothing registers with an engine that is being disposed and no error is reported for it.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { startWorkflowBureau } from './testing/workflow-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

describe('shutting down right after start', () => {
  it('reports no error, however soon the Bureau is shut down', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bureau-workflow-shutdown-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'digest.json'),
      workflowFileText('digest', { trigger: { kind: 'schedule', spec: '1h' } }),
    );
    const errors: string[] = [];
    for (let round = 0; round < 10; round += 1) {
      const harness = await startWorkflowBureau({
        directory: root,
        overrides: {
          onDiagnostic: (event) => {
            if (event.level === 'error') errors.push(event.message);
          },
        },
      });
      await harness.bureau.shutdown();
    }
    expect(errors).toEqual([]);
  });
});
