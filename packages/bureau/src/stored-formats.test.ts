/**
 * COR-2117, COR-2119, COR-2120 — the formats this build persists or reads from the owner, pinned by
 * literal values and by files kept in `__fixtures__/stored-formats/`.
 *
 * - `staging.validator.json` and `no-sauce.guardrail.json` are owner-written files; the digest each
 *   has is written out here, so a change to what a file means (a default added to a kind, a new
 *   canonical key) changes a digest and fails this test instead of silently moving every version an
 *   owner's goals and agents have pinned.
 * - `goal-record-with-definition.json`, `goal-record-with-configuration.json` and
 *   `agent-snapshot-written-by-this-build.json` are what this build writes; each must decode to
 *   exactly the bytes it was stored as, so a key a later change defaults or adds shows here, not as
 *   a goal or a snapshot that can no longer be read.
 * - `goal-record-written-by-main.json` was written by `createGoalState` at `main` before COR-2117
 *   (commit 702b267e2, built in a separate checkout of it, never by the code under test): it must
 *   still decode, and a goal stored that way must still run to its end.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AGENT_SNAPSHOT_KEY_PREFIX, createAgentSnapshotStore } from './agent-snapshot-store';
import type { Bureau } from './bureau-types/facade';
import { decodeGoalState, goalRecordKey, type GoalState } from './goal-state';
import { parseGuardrailFile } from './guardrail-file';
import {
  createCheckValidator,
  createTestDatabase,
  createUnsetTestDatabase,
  pollUntil,
  TERMINAL_STATUSES,
  type TestDatabase,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import { bootOver, inspect } from './testing/goal-recovery-fixtures.test-support';
import { parseValidatorFile } from './validator-file';

const FIXTURES = join(import.meta.dir, '__fixtures__', 'stored-formats');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

describe('the owner-written files', () => {
  it('give a validator file the version written out here, and the definition it means', () => {
    const parsed = parseValidatorFile('staging', fixture('staging.validator.json'));

    expect(parsed).toEqual({
      ok: true,
      version: '080bd4f5efa45c8f47b2afe42434367cce8302311cd933909aca725d5a4d3050',
      definition: {
        kind: 'match',
        description: 'The notes name the staging fix.',
        phrases: ['staging fix'],
        patterns: [],
        mode: 'all',
      },
    });
  });

  it('give a guardrail file the digest written out here, and the definition it means', () => {
    const parsed = parseGuardrailFile('no-sauce', fixture('no-sauce.guardrail.json'));

    expect(parsed).toEqual({
      ok: true,
      digest: 'dabb0e132defcd063726b30643b0887ea7784b1e33354321c45624b970a41cd8',
      definition: {
        kind: 'pattern',
        description: 'Keeps the secret sauce secret.',
        checks: 'output',
        action: 'block',
        phrases: ['secret-sauce'],
        patterns: [],
      },
    });
  });
});

describe('a stored goal record', () => {
  it.each([
    'goal-record-with-definition.json',
    'goal-record-with-configuration.json',
    'goal-record-written-by-main.json',
  ])('%s decodes to exactly the bytes it was stored as', (name) => {
    const text = fixture(name).trim();

    const decoded = decodeGoalState(text);

    expect(decoded).toBeDefined();
    // Nothing defaulted, dropped or reordered into the record on the way in.
    expect(JSON.parse(JSON.stringify(decoded))).toEqual(JSON.parse(text));
  });

  it('written by this build keeps the copy of the owner’s validator and the settings', () => {
    const withDefinition = decodeGoalState(fixture('goal-record-with-definition.json').trim());
    const configured = decodeGoalState(fixture('goal-record-with-configuration.json').trim());

    expect(withDefinition?.validator).toEqual({
      name: 'staging',
      version: '080bd4f5efa45c8f47b2afe42434367cce8302311cd933909aca725d5a4d3050',
    });
    expect(withDefinition?.validatorDefinition).toMatchObject({ kind: 'match' });
    expect(configured?.validatorConfiguration).toEqual({ phrase: 'staging fix' });
  });

  it('written by main has neither key, which this build reads as no settings and no copy', () => {
    const written = decodeGoalState(fixture('goal-record-written-by-main.json').trim());

    expect(written).toBeDefined();
    expect(written?.validatorConfiguration).toBeUndefined();
    expect(written?.validatorDefinition).toBeUndefined();
  });
});

describe('a stored agent snapshot', () => {
  it('written by this build loads, with the guardrail copy it holds, and nothing added', async () => {
    const text = fixture('agent-snapshot-written-by-this-build.json').trim();
    const stored = JSON.parse(text) as { id: string; hash: string };
    const store = textValueStore(new MemoryStorage());
    await store.set(`${AGENT_SNAPSHOT_KEY_PREFIX}${stored.id}:${stored.hash}`, text);
    const snapshots = createAgentSnapshotStore({ store, nowISO: () => '2026-11-16T12:00:00.000Z' });

    const loaded = await snapshots.load(stored.id, stored.hash);

    expect(loaded?.guardrailDefinitions?.[0]).toMatchObject({
      id: 'no-sauce',
      digest: 'dabb0e132defcd063726b30643b0887ea7784b1e33354321c45624b970a41cd8',
    });
    expect(JSON.parse(JSON.stringify(loaded))).toEqual(JSON.parse(text));
  });
});

describe('a goal stored by main before COR-2117', () => {
  const open: Bureau[] = [];
  const closers: Array<() => void> = [];
  let database: TestDatabase = createUnsetTestDatabase();
  afterEach(async () => {
    for (const bureau of open.splice(0)) await bureau.dispose();
    for (const close of closers.splice(0)) close();
    await database.remove();
  });

  it('is picked up from the store, run by the validator it names, and ends succeeded', async () => {
    database = createTestDatabase('stored-by-main');
    const view = await inspect(database.open());
    closers.push(() => view.dispose());
    await view.kv.set(goalRecordKey('g1'), fixture('goal-record-written-by-main.json').trim());

    const { bureau } = await bootOver({
      storage: database.open(),
      agents: {
        worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })),
      },
      validators: [createCheckValidator()],
    });
    open.push(bureau);
    await bureau.recovery();
    const stored = await bureau.goals.get('g1');
    if (stored?.status === 'pending') await bureau.goals.recover('g1');

    let latest: GoalState | undefined;
    await pollUntil(async () => {
      latest = await bureau.goals.get('g1');
      return (
        latest !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(latest.status)
      );
    });
    expect(latest).toMatchObject({ status: 'succeeded' });
    expect(latest?.validatorConfiguration).toBeUndefined();
    expect(latest?.attempts[0]?.validation?.judgedBy?.configuration).toBeNull();
  });
});
