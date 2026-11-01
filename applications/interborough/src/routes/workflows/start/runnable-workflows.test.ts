/** Which catalog rows the picker offers: the rule the workflow page's Start run follows. */
import { describe, expect, test } from 'bun:test';

import type { CatalogRow } from '../../../lib/workflow-catalog.ts';
import { invalidFile, readyFile } from '../../../lib/workflow-world.test-support.ts';
import { runnableWorkflows } from './runnable-workflows.ts';

function row(name: string, overrides: Partial<CatalogRow>): CatalogRow {
  return {
    name,
    kind: 'code',
    agent: null,
    description: null,
    engine: false,
    runs: null,
    trigger: null,
    file: null,
    problem: null,
    failure: null,
    ...overrides,
  };
}

describe('runnableWorkflows', () => {
  test('keeps a code-defined type and a ready file, in order', () => {
    const rows = [
      row('a-code', {}),
      row('b-file', { kind: 'agent-authored', file: readyFile('b-file') }),
    ];
    expect(runnableWorkflows(rows).map((entry) => entry.name)).toEqual(['a-code', 'b-file']);
  });

  test('leaves out the types the Bureau runs itself, a paused file and an invalid one', () => {
    const rows = [
      row('agentRun', { engine: true }),
      row('later', { kind: 'agent-authored', file: readyFile('later', { paused: true }) }),
      row('broken', { kind: 'agent-authored', file: invalidFile('broken') }),
    ];
    expect(runnableWorkflows(rows)).toEqual([]);
  });
});
