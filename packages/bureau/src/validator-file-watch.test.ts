/**
 * COR-2119 — an owner-defined validator file is watched, and a goal that began on it is not
 * changed by what happens to the file. A reload while a goal is using its definition is a state
 * machine, so what each event does is a table, event by situation, and each cell is a test.
 *
 * The situations are what the goal is doing when the file changes: none (a goal made now), an
 * attempt in flight, between two attempts, and a restart between the change and the check. The
 * events are a file added, edited, deleted, renamed, written malformed, and written in part.
 *
 * | event \ situation | a goal made now                                  | in flight, between attempts, after a restart |
 * | ----------------- | ------------------------------------------------ | -------------------------------------------- |
 * | added             | lists it; the old file still resolves            | the verdict is the goal's copy: V1           |
 * | edited            | lists V2; V1 is a version mismatch naming V2     | the verdict is the goal's copy: V1           |
 * | deleted           | lists nothing; V1 is missing                     | the verdict is the goal's copy: V1           |
 * | renamed           | lists the new name; the old is missing           | the verdict is the goal's copy: V1           |
 * | malformed         | lists nothing, rejected; V1 is missing           | the verdict is the goal's copy: V1           |
 * | half-written      | lists nothing, rejected; V1 is missing           | the verdict is the goal's copy: V1           |
 *
 * On main before this change there is nothing to compare with: a goal's validator came only from
 * `BureauOptions.validators` and plugins, a catalog frozen at startup, so none of these events
 * existed. A probe of `main` finds no `validatorSource` option and no `validators` folder. The
 * copy-the-definition rule is what keeps the right-hand column constant, and the tests below fail
 * when a goal resolves its validator from the file catalog again instead of from its record.
 *
 * A watcher scans on `fs.watch` and on a one-second heartbeat, so a scan can land between two steps
 * of a test. Every wait here is on the state the files leave (the listing a Bureau serves), never
 * on one event, a sleep or a deadline, and an event that is written in two steps is written so each
 * step is whole (a rename over the file), except the half-written file, whose point is that it is
 * not.
 */
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GenerateFunction } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import type { DefinitionsChangedEvent } from './events';
import type { GoalState } from './goal-state';
import { validatorFileDirectory } from './sources/validator-file-directory';
import {
  createTestDatabase,
  goalRequest,
  hangForever,
  pollUntil,
  TERMINAL_STATUSES,
  type TestDatabase,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import { parseValidatorFile } from './validator-file';

const STAGING_TEXT = JSON.stringify({
  kind: 'match',
  description: 'The notes mention the staging fix.',
  phrases: ['staging fix'],
});
const EDITED_TEXT = JSON.stringify({
  kind: 'match',
  description: 'The notes mention the rollback plan.',
  phrases: ['rollback plan'],
});
const FRESH_TEXT = JSON.stringify({ kind: 'match', description: 'Another.', phrases: ['other'] });

function versionOf(stem: string, text: string): string {
  const parsed = parseValidatorFile(stem, text);
  if (!parsed.ok) throw new Error(`fixture is not a valid file: ${parsed.code}`);
  return parsed.version;
}

const V1 = versionOf('staging', STAGING_TEXT);
const V2 = versionOf('staging', EDITED_TEXT);
const FRESH = versionOf('fresh', FRESH_TEXT);

interface World {
  readonly directory: string;
  readonly database: TestDatabase;
}

const bureaus: Bureau[] = [];
const worlds: World[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  for (const world of worlds.splice(0)) {
    await world.database.remove();
    await rm(world.directory, { recursive: true, force: true });
  }
});

/** A directory holding `staging.json`, and a database a restart can read again. */
async function startWorld(): Promise<World> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-validators-'));
  const world = { directory, database: createTestDatabase('validator-files') };
  worlds.push(world);
  await publish(world, 'staging.json', STAGING_TEXT);
  return world;
}

/** Writes `name` whole: a temporary file the directory ignores, renamed over it. */
async function publish(world: World, name: string, text: string): Promise<void> {
  await mkdir(world.directory, { recursive: true });
  const temporary = join(world.directory, `.${name}.tmp`);
  await writeFile(temporary, text);
  await rename(temporary, join(world.directory, name));
}

async function boot(world: World, generate: GenerateFunction, changes?: DefinitionsChangedEvent[]) {
  const bureau: Bureau = await createBureau<AgentDefinitions>({
    agents: { worker: workerAgent(generate) },
    storage: world.database.open(),
    durable: true,
    durableOwnership: { ownership: 'none' },
    validatorSource: validatorFileDirectory(world.directory),
  });
  bureau.addEventListener('definitions.changed', (event) => {
    changes?.push(event);
  });
  bureaus.push(bureau);
  return bureau;
}

/** Every validator a goal may name, as `name@version`. */
const listed = (bureau: Bureau): string[] =>
  bureau.goals.validators().map((row) => `${row.name}@${row.version}`);

interface FileEvent {
  readonly name: string;
  /** Does it to the directory. */
  readonly apply: (world: World) => Promise<void>;
  /** Whether the Bureau's catalog shows what it left. */
  readonly reflected: (bureau: Bureau) => boolean;
  /** What a goal made afterwards is told about the file's old version, and what it lists. */
  readonly afterwards: {
    readonly listing: readonly string[];
    readonly oldVersion: 'resolves' | 'missing' | 'mismatch';
  };
}

const EVENTS: readonly FileEvent[] = [
  {
    name: 'a file is added',
    apply: (world) => publish(world, 'fresh.json', FRESH_TEXT),
    reflected: (bureau) => listed(bureau).includes(`fresh@${FRESH}`),
    afterwards: { listing: [`fresh@${FRESH}`, `staging@${V1}`], oldVersion: 'resolves' },
  },
  {
    name: 'the file is edited',
    apply: (world) => publish(world, 'staging.json', EDITED_TEXT),
    reflected: (bureau) => listed(bureau).includes(`staging@${V2}`),
    afterwards: { listing: [`staging@${V2}`], oldVersion: 'mismatch' },
  },
  {
    name: 'the file is deleted',
    apply: (world) => rm(join(world.directory, 'staging.json')),
    reflected: (bureau) => listed(bureau).length === 0,
    afterwards: { listing: [], oldVersion: 'missing' },
  },
  {
    name: 'the file is renamed',
    apply: (world) =>
      rename(join(world.directory, 'staging.json'), join(world.directory, 'renamed.json')),
    reflected: (bureau) => listed(bureau).includes(`renamed@${V1}`),
    afterwards: { listing: [`renamed@${V1}`], oldVersion: 'missing' },
  },
  {
    name: 'the file is written malformed',
    apply: (world) => publish(world, 'staging.json', '{ "kind": "match", nope'),
    reflected: (bureau) => listed(bureau).length === 0,
    afterwards: { listing: [], oldVersion: 'missing' },
  },
  {
    name: 'the file is written in part',
    // In place and cut short, as a write that has not finished leaves it.
    apply: (world) => writeFile(join(world.directory, 'staging.json'), STAGING_TEXT.slice(0, 30)),
    reflected: (bureau) => listed(bureau).length === 0,
    afterwards: { listing: [], oldVersion: 'missing' },
  },
];

const ANSWERS_STAGING: GenerateFunction = () =>
  Promise.resolve({ content: 'the staging fix landed', toolCalls: [] });

/** A goal on the file as it was: `staging` at `V1`. */
const onStagingFile = (id = 'g1') =>
  goalRequest({ goalRunId: id, validator: { name: 'staging', version: V1 } });

async function ended(bureau: Bureau, goalRunId = 'g1'): Promise<GoalState> {
  let latest: GoalState | undefined;
  await pollUntil(async () => {
    latest = await bureau.goals.get(goalRunId);
    return latest !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(latest.status);
  });
  return latest!;
}

/** Whether the goal is `status` now. */
async function goalIs(bureau: Bureau, goalRunId: string, status: string): Promise<boolean> {
  const goal = await bureau.goals.get(goalRunId);
  return goal?.status === status;
}

/** The definition a goal copied, now. */
async function copiedDefinition(bureau: Bureau, goalRunId: string) {
  const goal = await bureau.goals.get(goalRunId);
  return goal?.validatorDefinition;
}

/** The definition a goal had copied when it ended. */
async function endedDefinition(bureau: Bureau, goalRunId: string) {
  const goal = await ended(bureau, goalRunId);
  return goal.validatorDefinition;
}

/** The verdicts of a goal, as `[version, outcome]` per attempt. */
const judged = (goal: GoalState) =>
  goal.attempts.map((attempt) => [
    attempt.validation?.judgedBy?.validator.version,
    attempt.validation?.outcome.kind,
  ]);

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('a goal made after the file changes', () => {
  it.each(EVENTS)('sees what $name left, and only that', async (event) => {
    const world = await startWorld();
    const bureau = await boot(world, ANSWERS_STAGING);
    expect(listed(bureau)).toEqual([`staging@${V1}`]);

    await event.apply(world);
    await waitUntil(() => event.reflected(bureau), { message: `the catalog shows ${event.name}` });

    expect(listed(bureau)).toEqual([...event.afterwards.listing]);
    const outcome = await bureau.goals.create(onStagingFile('after'));
    switch (event.afterwards.oldVersion) {
      case 'resolves':
        expect(outcome).toMatchObject({ outcome: 'created' });
        break;
      case 'missing':
        expect(outcome).toMatchObject({ outcome: 'rejected', code: 'validator-missing' });
        break;
      case 'mismatch':
        expect(outcome).toMatchObject({
          outcome: 'rejected',
          code: 'validator-version-mismatch',
          availableVersions: [V2],
        });
        break;
    }
  });

  it('judges a goal on the edited file by the edit, from the version it names', async () => {
    const world = await startWorld();
    const bureau = await boot(world, () =>
      Promise.resolve({ content: 'the rollback plan is ready', toolCalls: [] }),
    );
    await publish(world, 'staging.json', EDITED_TEXT);
    await waitUntil(() => listed(bureau).includes(`staging@${V2}`));

    await bureau.goals.create(
      goalRequest({ goalRunId: 'edited', validator: { name: 'staging', version: V2 } }),
    );

    const goal = await ended(bureau, 'edited');
    expect(goal).toMatchObject({ status: 'succeeded' });
    expect(judged(goal)).toEqual([[V2, 'pass']]);
  });

  it('lists the file again, under its new version, once a half-written file is finished', async () => {
    const world = await startWorld();
    const bureau = await boot(world, ANSWERS_STAGING);
    await writeFile(join(world.directory, 'staging.json'), STAGING_TEXT.slice(0, 30));
    await waitUntil(() => listed(bureau).length === 0);

    await publish(world, 'staging.json', EDITED_TEXT);

    await waitUntil(() => listed(bureau).includes(`staging@${V2}`));
    expect(listed(bureau)).toEqual([`staging@${V2}`]);
  });
});

describe('a goal that began on the file', () => {
  it.each(EVENTS)('keeps its verdict when $name while an attempt is in flight', async (event) => {
    const world = await startWorld();
    const gate = latch();
    const bureau = await boot(world, async () => {
      await gate.promise;
      return { content: 'the staging fix landed', toolCalls: [] };
    });
    await bureau.goals.create(onStagingFile());
    await pollUntil(() => goalIs(bureau, 'g1', 'running'));

    await event.apply(world);
    await waitUntil(() => event.reflected(bureau));
    gate.release();

    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded', terminalReason: 'validator-passed' });
    expect(judged(goal)).toEqual([[V1, 'pass']]);
    expect(goal.attempts[0]?.validation?.judgedBy?.source).toMatchObject({ kind: 'bungalow' });
  });

  it.each(EVENTS)('keeps its verdicts when $name between two attempts', async (event) => {
    const world = await startWorld();
    const second = latch();
    let calls = 0;
    const bureau = await boot(world, async () => {
      calls += 1;
      if (calls === 1) return { content: 'nothing yet', toolCalls: [] };
      await second.promise;
      return { content: 'the staging fix landed', toolCalls: [] };
    });
    await bureau.goals.create(onStagingFile());
    // The first attempt fails the check, and the retry is waiting when the file changes.
    await pollUntil(async () => {
      const goal = await bureau.goals.get('g1');
      return goal?.status === 'running' && goal.attempts.length === 2;
    });

    await event.apply(world);
    await waitUntil(() => event.reflected(bureau));
    second.release();

    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded' });
    expect(judged(goal)).toEqual([
      [V1, 'fail'],
      [V1, 'pass'],
    ]);
  });

  it.each(EVENTS)('keeps its verdict across a restart after $name', async (event) => {
    const world = await startWorld();
    // The first Bureau starts the attempt and never finishes it, as a process that died would.
    const dead = await boot(world, hangForever);
    await dead.goals.create(onStagingFile());
    await pollUntil(() => goalIs(dead, 'g1', 'running'));
    await event.apply(world);

    // The second reads the directory as the event left it, and the goal's record from storage.
    const revived = await boot(world, ANSWERS_STAGING);
    await waitUntil(() => event.reflected(revived));

    const goal = await ended(revived);
    expect(goal).toMatchObject({ status: 'succeeded' });
    expect(judged(goal)).toEqual([[V1, 'pass']]);
  });

  it('runs from its copy after the whole directory is gone', async () => {
    const world = await startWorld();
    const dead = await boot(world, hangForever);
    await dead.goals.create(onStagingFile());
    await pollUntil(() => goalIs(dead, 'g1', 'running'));
    expect(await copiedDefinition(dead, 'g1')).toMatchObject({
      kind: 'match',
      phrases: ['staging fix'],
    });
    await rm(world.directory, { recursive: true });

    const revived = await boot(world, ANSWERS_STAGING);

    expect(listed(revived)).toEqual([]);
    expect(judged(await ended(revived))).toEqual([[V1, 'pass']]);
  });
});

describe('definitions.changed for validator files', () => {
  it('reports an invalid file, a command kind, and a stem holding a colon as rejected, and nothing of their text', async () => {
    const world = await startWorld();
    const changes: DefinitionsChangedEvent[] = [];
    const bureau = await boot(world, ANSWERS_STAGING, changes);
    expect(bureau.goals.validators().map((row) => row.name)).toEqual(['staging']);

    await publish(world, 'broken.json', '{"kind": "match", "description": "SENTINEL-TEXT-91c4"');
    await publish(world, 'runs-commands.json', JSON.stringify({ kind: 'command', command: 'ls' }));
    await publish(
      world,
      'plug:in.json',
      JSON.stringify({ kind: 'match', description: 'x', phrases: ['a'] }),
    );

    await waitUntil(() =>
      ['broken', 'runs-commands', 'plug:in'].every((id) =>
        changes.some((change) => change.rejected.includes(id)),
      ),
    );
    for (const id of ['broken', 'runs-commands', 'plug:in']) {
      const change = changes.find((candidate) => candidate.rejected.includes(id));
      expect(change).toMatchObject({ catalog: 'validators' });
      expect(change?.added).toContain(id);
    }
    expect(JSON.stringify(changes)).not.toContain('SENTINEL-TEXT');
    // None of them is a validator a goal may name.
    expect(bureau.goals.validators().map((row) => row.name)).toEqual(['staging']);
  });

  it('reports the files present at start as no change, and a later edit as changed', async () => {
    const world = await startWorld();
    const changes: DefinitionsChangedEvent[] = [];
    const bureau = await boot(world, ANSWERS_STAGING, changes);
    expect(changes).toEqual([]);

    await publish(world, 'staging.json', EDITED_TEXT);

    await waitUntil(() => changes.some((change) => change.changed.includes('staging')));
    expect(listed(bureau)).toEqual([`staging@${V2}`]);
  });
});

describe('the validators an owner lists', () => {
  it('names a validator file by its stem with the digest as its version and the bungalow as its source', async () => {
    const world = await startWorld();
    const bureau = await boot(world, ANSWERS_STAGING);

    expect(bureau.goals.validators()).toEqual([
      {
        name: 'staging',
        version: V1,
        determinism: 'deterministic',
        configuration: null,
        source: { kind: 'bungalow', name: 'bungalow', version: V1 },
      },
    ]);
  });

  it('is not shadowed by, and does not shadow, the validators the host gave the Bureau', async () => {
    const world = await startWorld();
    const bureau: Bureau = await createBureau<AgentDefinitions>({
      agents: { worker: workerAgent(ANSWERS_STAGING) },
      storage: world.database.open(),
      durable: true,
      durableOwnership: { ownership: 'none' },
      validators: [
        {
          identity: { name: 'staging', version: '1' },
          validate: () => ({ kind: 'pass', evidence: [] }),
        },
      ],
      validatorSource: validatorFileDirectory(world.directory),
    });
    bureaus.push(bureau);

    // The frozen catalog is asked first, so its version resolves to it, and the file's by its digest.
    expect(
      await bureau.goals.create(
        goalRequest({ goalRunId: 'frozen', validator: { name: 'staging', version: '1' } }),
      ),
    ).toMatchObject({ outcome: 'created' });
    expect(
      await bureau.goals.create(
        goalRequest({ goalRunId: 'filed', validator: { name: 'staging', version: V1 } }),
      ),
    ).toMatchObject({ outcome: 'created' });
    expect(await endedDefinition(bureau, 'frozen')).toBeUndefined();
    expect(await endedDefinition(bureau, 'filed')).toMatchObject({ kind: 'match' });
  });
});
