import { expect } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createScenarios } from './chef/scenario.test-support.ts';
import { collectAccounting } from './ci-run-accounting-collection.ts';

const scenarios = createScenarios();
scenarios.scenario(
  'persists the selected provider runs as an immutable accounting input',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ci-accounting-'));
    try {
      const options = {
        client: {
          get: async () => ({ total_count: 0, workflow_runs: [] }),
          graphql: async () => ({}),
          calls: () => 1,
        },
        remoteUrl: 'https://github.com/owner/repository.git',
        mainRevision: 'a'.repeat(40),
        selectionOnly: true,
      };
      const collect = () =>
        collectAccounting(
          'owner/repository',
          '2026-11-01T00:00:00Z',
          '2026-11-02T00:00:00Z',
          directory,
          options,
        );
      const first = await collect();
      expect(JSON.parse(await readFile(join(directory, 'selection.json'), 'utf8'))).toEqual(
        first.selection,
      );
      expect(await collect()).toEqual(first);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
await scenarios.settled();
