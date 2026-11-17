/**
 * COR-2120 — a guardrail the owner wrote as a JSON file, named by an agent file by the file's stem:
 * it stops an output, a tool call, or an input on a real run; an edit changes the agents that name
 * it from their next run; a file that cannot be used, or whose stem holds a colon, is rejected
 * through `definitions.changed`; and the guardrails are listed beside the plugins'.
 *
 * Whether a run that began before an edit keeps the guardrail it began with is
 * `guardrail-file-snapshots.test.ts`.
 */
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import type { DefinitionsChangedEvent } from './events';
import { guardrailFileDirectory } from './sources/guardrail-file-directory';
import { waitForTaskState } from './test';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';

const harnesses: FileBureauHarness[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const NO_SAUCE = JSON.stringify({
  kind: 'pattern',
  description: 'Keeps the secret sauce secret.',
  checks: 'output',
  phrases: ['secret-sauce'],
});

interface Activity {
  readonly finishReason: string;
  readonly content: string;
  readonly feed: ReadonlyArray<{ kind: string; payload: Record<string, unknown> }>;
}

/** A Bureau over a guardrail directory holding `files`, and an agent `helper` with `frontmatter`. */
async function start(
  files: Record<string, string>,
  frontmatter: Record<string, string>,
  script: (
    generations: number,
  ) => string | { content: string; toolCalls: { name: string; arguments: object }[] },
  changes?: DefinitionsChangedEvent[],
) {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-guardrail-files-'));
  directories.push(directory);
  for (const [name, text] of Object.entries(files)) await writeFile(join(directory, name), text);
  const harness: FileBureauHarness = await startFileBureau({
    scripts: { 'claude-opus-5-5': () => script(harness.observed.length) },
    overrides: { guardrailSource: guardrailFileDirectory(directory) },
  });
  harnesses.push(harness);
  harness.bureau.addEventListener('definitions.changed', (event) => {
    changes?.push(event);
  });
  await harness.put(
    'helper.md',
    agentFileText({ model: KNOWN_MODEL, tools: '[lookup-order]', ...frontmatter }),
  );
  await harness.bureau.agents.refresh();
  return { harness, directory };
}

async function run(harness: FileBureauHarness, input: string): Promise<Activity> {
  const task = await harness.bureau.tasks.start('helper', input);
  const result = await task.result();
  await waitForTaskState(harness.bureau, task.id);
  const feed: Activity['feed'][number][] = [];
  const runFeed = harness.bureau.internals.runEventFeeds.get(task.id);
  if (runFeed === undefined) throw new Error('Expected the run to have a feed.');
  for await (const envelope of runFeed.feed.replay()) {
    feed.push({ kind: envelope.kind, payload: { ...envelope.payload } });
  }
  return { finishReason: result.finishReason, content: result.content, feed };
}

const fired = (activity: Activity) =>
  activity.feed.filter((event) => event.kind === 'run.guardrail').map((event) => event.payload);

describe('an agent that names an output guardrail by its file', () => {
  it('blocks an output that holds the phrase, and lets one that does not through', async () => {
    const { harness } = await start(
      { 'no-sauce.json': NO_SAUCE },
      { guardrails: '[no-sauce]' },
      (generations) =>
        generations === 1 ? 'Here is the SECRET-SAUCE recipe.' : 'Nothing special.',
    );

    const blocked = await run(harness, 'Tell me.');
    expect(fired(blocked)).toEqual([
      expect.objectContaining({ guardrailName: 'no-sauce', phase: 'output', action: 'block' }),
    ]);
    expect(blocked.content.toLowerCase()).not.toContain('secret-sauce');

    const clean = await run(harness, 'Tell me again.');
    expect(fired(clean)).toEqual([]);
    expect(clean.content).toBe('Nothing special.');
  });

  it('does not apply it to an agent that does not name it', async () => {
    const { harness } = await start({ 'no-sauce.json': NO_SAUCE }, {}, () => 'The secret-sauce.');

    const activity = await run(harness, 'Tell me.');

    expect(fired(activity)).toEqual([]);
    expect(activity.content).toBe('The secret-sauce.');
  });

  it('halts the run when the file says tripwire', async () => {
    const { harness } = await start(
      { 'no-sauce.json': JSON.stringify({ ...JSON.parse(NO_SAUCE), action: 'tripwire' }) },
      { guardrails: '[no-sauce]' },
      () => 'The secret-sauce.',
    );

    const activity = await run(harness, 'Tell me.');

    expect(activity.finishReason).toBe('tripwire');
    expect(
      activity.feed.filter((event) => event.kind === 'run.tripwire').map((event) => event.payload),
    ).toEqual([expect.objectContaining({ phase: 'output', guardrailName: 'no-sauce' })]);
  });
});

describe('a tool-call guardrail the owner wrote', () => {
  const NO_DROPS = JSON.stringify({
    kind: 'pattern',
    description: 'No dropping tables.',
    checks: 'tool-call',
    phrases: ['drop table'],
  });
  const callWith = (note: string) => (generations: number) =>
    generations === 1
      ? { content: '', toolCalls: [{ name: 'lookup-order', arguments: { note } }] }
      : 'Done.';
  const firstStepOutcomes = (activity: Activity) =>
    activity.feed
      .filter((event) => event.kind === 'step.completed' && event.payload['step'] === 0)
      .flatMap((event) => event.payload['results'] as Array<{ outcome: string }>)
      .map((result) => result.outcome);

  it('refuses a call whose serialized arguments match, and the call never runs', async () => {
    const { harness } = await start(
      { 'no-drops.json': NO_DROPS },
      { guardrails: '[no-drops]' },
      callWith('please DROP TABLE orders'),
    );

    const activity = await run(harness, 'Look it up.');

    expect(fired(activity)).toEqual([
      expect.objectContaining({ guardrailName: 'no-drops', phase: 'tool-call', action: 'block' }),
    ]);
    expect(activity.feed.filter((event) => event.kind === 'tools.executing')).toEqual([]);
    expect(firstStepOutcomes(activity)).toEqual(['error']);
  });

  it('lets a call whose arguments do not match run', async () => {
    const { harness } = await start(
      { 'no-drops.json': NO_DROPS },
      { guardrails: '[no-drops]' },
      callWith('an ordinary note'),
    );

    const activity = await run(harness, 'Look it up.');

    expect(fired(activity)).toEqual([]);
    expect(firstStepOutcomes(activity)).toEqual(['success']);
  });
});

describe('an input guardrail the owner wrote', () => {
  it('fires on what the user says, and halts a tripwire before the model is asked', async () => {
    const { harness } = await start(
      {
        'no-drops.json': JSON.stringify({
          kind: 'pattern',
          description: 'No drops.',
          checks: 'input',
          action: 'tripwire',
          phrases: ['drop table'],
        }),
      },
      { guardrails: '[no-drops]' },
      () => 'unused',
    );

    const activity = await run(harness, 'Please drop table users.');

    expect(activity.finishReason).toBe('tripwire');
    expect(harness.observed).toHaveLength(0);
  });
});

describe('editing a guardrail file', () => {
  it('changes the next run of the agents that name it, and no other file', async () => {
    const { harness, directory } = await start(
      { 'no-sauce.json': NO_SAUCE },
      { guardrails: '[no-sauce]' },
      () => 'The secret-sauce and the family recipe.',
    );
    const before = harness.bureau.agents.list().find((entry) => entry.id === 'helper');
    expect(fired(await run(harness, 'Tell me.'))).toHaveLength(1);

    // Whole, so a scan reads the file before or after, never between.
    await writeFile(
      join(directory, '.no-sauce.tmp'),
      JSON.stringify({ ...JSON.parse(NO_SAUCE), phrases: ['family recipe'] }),
    );
    await rename(join(directory, '.no-sauce.tmp'), join(directory, 'no-sauce.json'));
    await waitUntil(
      () =>
        harness.bureau.agents.list().find((entry) => entry.id === 'helper')?.definitionRevision !==
        before?.definitionRevision,
    );

    const after = await run(harness, 'Tell me.');
    expect(fired(after)).toHaveLength(1);
    // The edit moved the phrase: what the first reply said is no longer what is looked for.
    expect(after.content.toLowerCase()).not.toContain('family recipe');
    const listing = harness.bureau.agents.list().find((entry) => entry.id === 'helper');
    // The file's own bytes did not change, so its hash is what it was, and its revision is not.
    expect(listing?.definitionHash).toBe(before?.definitionHash);
    expect(listing?.definitionRevision).toBe((before?.definitionRevision ?? 0) + 1);
  });

  it('makes an agent that names a guardrail whose file was deleted invalid, reference-unresolved', async () => {
    const { harness, directory } = await start(
      { 'no-sauce.json': NO_SAUCE },
      { guardrails: '[no-sauce]' },
      () => 'Hello.',
    );
    expect(harness.bureau.agents.list().find((entry) => entry.id === 'helper')?.state).toBe(
      'ready',
    );

    await rm(join(directory, 'no-sauce.json'));
    await waitUntil(
      () =>
        harness.bureau.agents.list().find((entry) => entry.id === 'helper')?.state === 'invalid',
    );

    expect(harness.bureau.agents.list().find((entry) => entry.id === 'helper')?.problem?.code).toBe(
      'reference-unresolved',
    );
  });

  it('is not what an agent that names a plugin-style id with a colon resolves, even by that stem', async () => {
    const { harness } = await start(
      { 'plug:in.json': NO_SAUCE },
      { guardrails: '[plug:in]' },
      () => 'Hello.',
    );

    const listing = harness.bureau.agents.list().find((entry) => entry.id === 'helper');

    expect(listing?.state).toBe('invalid');
    expect(listing?.problem?.code).toBe('reference-unresolved');
  });
});

describe('definitions.changed for guardrail files', () => {
  it('rejects a malformed regular expression and a stem holding a colon, naming neither’s text', async () => {
    const changes: DefinitionsChangedEvent[] = [];
    const { directory } = await start({ 'no-sauce.json': NO_SAUCE }, {}, () => 'Hello.', changes);
    // The guardrail file present at start is not reported as added (the agent file the test writes
    // is, which is another catalog's report).
    expect(changes.filter((change) => change.catalog === 'guardrails')).toEqual([]);

    await writeFile(
      join(directory, 'bad-pattern.json'),
      JSON.stringify({
        kind: 'pattern',
        description: 'SENTINEL-TEXT-5b1e',
        checks: 'output',
        patterns: ['(SENTINEL-TEXT-5b1e'],
      }),
    );
    await writeFile(join(directory, 'plug:in.json'), NO_SAUCE);

    await waitUntil(() =>
      ['bad-pattern', 'plug:in'].every((id) =>
        changes.some((change) => change.rejected.includes(id)),
      ),
    );
    for (const id of ['bad-pattern', 'plug:in']) {
      const change = changes.find((candidate) => candidate.rejected.includes(id));
      expect(change).toMatchObject({ catalog: 'guardrails' });
      expect(change?.added).toContain(id);
    }
    expect(JSON.stringify(changes)).not.toContain('SENTINEL-TEXT');
  });
});

describe('bureau.guardrails.list', () => {
  it('lists an owner’s guardrail with its stem, no plugin, and the bungalow as its source, in the family its checks put it in', async () => {
    const { harness } = await start(
      {
        'no-sauce.json': NO_SAUCE,
        'no-drops.json': JSON.stringify({
          kind: 'pattern',
          description: 'No dropping tables.',
          checks: 'tool-call',
          phrases: ['drop table'],
        }),
        'no-keys.json': JSON.stringify({
          kind: 'pattern',
          description: 'No keys in tool results.',
          checks: 'tool-result',
          phrases: ['api_key='],
        }),
      },
      {},
      () => 'Hello.',
    );

    const owned = harness.bureau.plugins
      .guardrails()
      .filter((row) => row.source === 'bungalow')
      .map((row) => [row.id, row.family, row.plugin, row.configurable, row.configuration]);

    expect(owned).toEqual([
      ['no-drops', 'tools', null, false, null],
      ['no-keys', 'input', null, false, null],
      ['no-sauce', 'output', null, false, null],
    ]);
  });
});
