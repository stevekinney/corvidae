/**
 * COR-2119 — the catalog changes while `create` awaits, so the record is built from the reading
 * that accepts the create. A scan that finds a half-written validator file misses it at the start of
 * the call; the next scan settles the complete file during the awaits; the create is then accepted,
 * and the goal must carry the copy of the file it was accepted against, and one a file that went
 * during the awaits must be refused.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { createGoalStore } from './goal-store';
import { createGoalValidatorCatalog } from './goal-validator-catalog';
import { createBureauGoals } from './goals';
import { dependencies, scriptedEngine } from './testing/goal-control-fixtures.test-support';
import { goalRequest } from './testing/goal-fixtures.test-support';
import type { ReadyValidatorFile } from './validator-file-catalog';
import { parseValidatorFile } from './validator-file';

const FILE_TEXT = JSON.stringify({
  kind: 'match',
  description: 'The notes name the staging fix.',
  phrases: ['staging fix'],
});

function readyFile(): ReadyValidatorFile {
  const parsed = parseValidatorFile('staging', FILE_TEXT);
  if (!parsed.ok) throw new Error(`fixture is not a valid file: ${parsed.code}`);
  return { name: 'staging', hash: 'h', version: parsed.version, definition: parsed.definition };
}

/** A goals service over a file catalog the test changes, between the first reading and the write. */
function harness(present: { current: boolean }, whileAwaiting: () => void) {
  const baseStore = createGoalStore(textValueStore(new MemoryStorage()));
  const store = {
    ...baseStore,
    // The first await of `create` after the catalog was first read.
    get: async (goalRunId: string) => {
      const stored = await baseStore.get(goalRunId);
      whileAwaiting();
      return stored;
    },
  };
  const file = readyFile();
  const catalog = createGoalValidatorCatalog([], undefined, () => ({
    find: (name) => (present.current && name === file.name ? file : undefined),
    ready: () => (present.current ? [file] : []),
  }));
  const { engine } = scriptedEngine({ workflows: {} });
  const { control } = dependencies(store, engine, { catalog });
  const goals = createBureauGoals({
    ...control,
    runtime: { identifiers: undefined as never },
    resolveFreshAttemptSource: undefined,
    planAgent: () => ({ durable: true, agentVersion: '1' }),
  });
  return { goals, baseStore, file };
}

describe('a goal that names an owner’s validator file while a scan settles it', () => {
  it('is recorded with the copy of the file that accepted it, not none', async () => {
    const present = { current: false };
    const { goals, baseStore, file } = harness(present, () => {
      present.current = true;
    });

    const created = await goals.create(
      goalRequest({ validator: { name: 'staging', version: file.version } }),
    );

    // The first reading found no file (it was half written); the reading that accepted did.
    expect(created).toMatchObject({ outcome: 'created' });
    const stored = await baseStore.get('g1');
    expect(stored?.validatorDefinition).toEqual(file.definition);
  });

  it('is refused when the file went while the call awaited, and nothing is stored', async () => {
    const present = { current: true };
    const { goals, baseStore, file } = harness(present, () => {
      present.current = false;
    });

    const created = await goals.create(
      goalRequest({ validator: { name: 'staging', version: file.version } }),
    );

    expect(created).toMatchObject({ outcome: 'rejected', code: 'validator-missing' });
    expect(await baseStore.get('g1')).toBeUndefined();
  });
});
