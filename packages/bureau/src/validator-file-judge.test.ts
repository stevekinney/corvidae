/**
 * COR-2123 — the `judge` kind of an owner-defined validator file: a model judges an attempt against
 * the file's rubric, as a Bureau model call of the goal's owner. Every model here is a scripted
 * provider; no test calls a live one. A judge that cannot answer, answers in a form that does not
 * parse, or runs out of time is a named verdict, never a pass.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMockGenerate, type GenerateFunction } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import type { DefinitionsChangedEvent } from './events';
import type { GoalState } from './goal-state';
import { validatorFileDirectory } from './sources/validator-file-directory';
import {
  answering,
  goalRequest,
  pollUntil,
  TERMINAL_STATUSES,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import { createVendorCatalog } from './testing/vendor-catalog.test-support';
import { parseValidatorFile } from './validator-file';

const MODEL = 'anthropic/claude-haiku-5-5';
const JUDGE_FILE = JSON.stringify({
  kind: 'judge',
  description: 'Reads like release notes.',
  model: MODEL,
  rubric: 'The answer is written as release notes, with a date.',
});
const VERSION = (() => {
  const parsed = parseValidatorFile('release-notes', JUDGE_FILE);
  if (!parsed.ok) throw new Error('fixture');
  return parsed.version;
})();

const bureaus: Bureau[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const verdict = (passes: boolean, missing: string[] = []) => ({
  content: JSON.stringify({ passes, missing }),
  toolCalls: [],
});

/** A Bureau over a directory holding the judge file, whose model catalog answers from `generate`. */
async function open(generate: GenerateFunction, files: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-judge-'));
  directories.push(directory);
  for (const [name, text] of Object.entries({ 'release-notes.json': JUDGE_FILE, ...files })) {
    await writeFile(join(directory, name), text);
  }
  const changes: DefinitionsChangedEvent[] = [];
  const bureau = await createBureau<AgentDefinitions>({
    storage: new MemoryStorage(),
    durable: true,
    agents: { worker: workerAgent(answering('Release 1.2, 3 November: fixes.')) },
    models: { catalog: createVendorCatalog().descriptors, generate: () => generate },
    validatorSource: validatorFileDirectory(directory),
  });
  bureau.addEventListener('definitions.changed', (event) => {
    changes.push(event);
  });
  bureaus.push(bureau);
  return { bureau, directory, changes };
}

const JUDGED = { name: 'release-notes', version: VERSION } as const;

async function ended(bureau: Bureau, goalRunId = 'g1'): Promise<GoalState> {
  let latest: GoalState | undefined;
  await pollUntil(async () => {
    latest = await bureau.goals.get(goalRunId);
    return latest !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(latest.status);
  });
  return latest!;
}

describe('a goal judged by a model', () => {
  it('passes when the judge says the answer satisfies the rubric, and names the judge in the verdict', async () => {
    const { bureau } = await open(createMockGenerate([verdict(true)]));

    await bureau.goals.create(goalRequest({ validator: JUDGED }));
    const goal = await ended(bureau);

    expect(goal).toMatchObject({ status: 'succeeded', terminalReason: 'validator-passed' });
    expect(goal.attempts[0]?.validation).toMatchObject({
      outcome: { kind: 'pass' },
      judgedBy: { validator: JUDGED, source: { kind: 'bungalow' } },
    });
  });

  it('fails with what the judge said is missing as the feedback, and retries', async () => {
    const generate = createMockGenerate([
      verdict(false, ['a release date', 'the fixes it contains']),
      verdict(true),
    ]);
    const { bureau } = await open(generate);

    await bureau.goals.create(goalRequest({ validator: JUDGED }));
    const goal = await ended(bureau);

    expect(goal).toMatchObject({ status: 'succeeded' });
    const first = goal.attempts[0]?.validation?.outcome;
    expect(first).toMatchObject({ kind: 'fail', retryable: true });
    expect(first?.kind === 'fail' && first.feedback).toBe('a release date\nthe fixes it contains');
    expect(goal.attempts[1]?.validation?.outcome).toMatchObject({ kind: 'pass' });
    expect(generate.callCount).toBe(2);
  });

  it('is indeterminate, not a pass, when the judge’s answer does not parse', async () => {
    // The language-model fallback asks twice before it gives up on an answer.
    const { bureau } = await open(
      createMockGenerate([
        { content: 'I think it is fine.', toolCalls: [] },
        { content: 'Still fine.', toolCalls: [] },
      ]),
    );

    await bureau.goals.create(goalRequest({ validator: JUDGED, retryPolicy: undefined }));
    const goal = await ended(bureau);

    expect(goal.status).not.toBe('succeeded');
    expect(goal.attempts[0]?.validation?.outcome).toMatchObject({
      kind: 'indeterminate',
      reason: 'VALIDATOR_JUDGE_ANSWER_UNPARSEABLE',
    });
  });

  it('is indeterminate, not a pass, when the model fails', async () => {
    const { bureau } = await open(() => Promise.reject(new Error('the provider is down')));

    await bureau.goals.create(goalRequest({ validator: JUDGED, retryPolicy: undefined }));
    const goal = await ended(bureau);

    expect(goal.status).not.toBe('succeeded');
    expect(goal.attempts[0]?.validation?.outcome).toMatchObject({ kind: 'indeterminate' });
  });

  it('ends an error of kind timeout, not a pass, when the judge outlasts the validator timeout', async () => {
    const hangs: GenerateFunction = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const { bureau } = await open(hangs);

    await bureau.goals.create(
      goalRequest({ validator: JUDGED, retryPolicy: undefined, validatorTimeoutMs: 50 }),
    );
    const goal = await ended(bureau);

    expect(goal.status).not.toBe('succeeded');
    expect(goal.attempts[0]?.validation?.outcome).toMatchObject({
      kind: 'error',
      error: { kind: 'timeout' },
    });
  });

  it('is refused by a goal that requires deterministic validation, which ends failed before an attempt', async () => {
    const generate = createMockGenerate([verdict(true)]);
    const { bureau } = await open(generate);

    await bureau.goals.create(
      goalRequest({ validator: JUDGED, requireDeterministicValidation: true }),
    );
    const goal = await ended(bureau);

    expect(goal).toMatchObject({ status: 'failed', terminalReason: 'unsupported-validation' });
    expect(goal.attempts).toEqual([]);
    expect(generate.callCount).toBe(0);
  });

  it('is listed as stochastic, with the bungalow as its source', async () => {
    const { bureau } = await open(createMockGenerate([verdict(true)]));

    expect(bureau.goals.validators()).toEqual([
      {
        name: 'release-notes',
        version: VERSION,
        determinism: 'stochastic',
        configuration: null,
        source: { kind: 'bungalow', name: 'bungalow', version: VERSION },
      },
    ]);
  });
});

describe('the judge’s model call', () => {
  it('is recorded against the goal’s owner and filed under the goal, on the model the file names', async () => {
    const { bureau } = await open(createMockGenerate([verdict(true)]));

    await bureau.goals.create(goalRequest({ validator: JUDGED, principal: 'api-key:alice' }));
    await ended(bureau);

    const records = (await bureau.internals.auditTrail?.query({ type: 'decision.made' })) ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      runId: 'g1',
      principal: 'api-key:alice',
      detail: { outcome: 'answered', row: MODEL },
    });
  });

  it('is made as the local owner for a goal that names none', async () => {
    const { bureau } = await open(createMockGenerate([verdict(true)]));

    await bureau.goals.create(goalRequest({ validator: JUDGED }));
    await ended(bureau);

    const records = (await bureau.internals.auditTrail?.query({ type: 'decision.made' })) ?? [];
    expect(records.map((record) => record.principal)).toEqual(['anonymous:local']);
  });

  it('uses the model the file names, whichever model the decisions setting would choose', async () => {
    const { bureau } = await open(createMockGenerate([verdict(true)]), {
      'sonnet-judge.json': JSON.stringify({
        kind: 'judge',
        description: 'Another.',
        model: 'anthropic/claude-sonnet-5-5',
        rubric: 'Reads well.',
      }),
    });
    const sonnet = bureau.goals.validators().find((row) => row.name === 'sonnet-judge');
    expect(sonnet).toBeDefined();

    await bureau.goals.create(
      goalRequest({ validator: { name: 'sonnet-judge', version: sonnet!.version } }),
    );
    await ended(bureau);

    const records = (await bureau.internals.auditTrail?.query({ type: 'decision.made' })) ?? [];
    expect(records[0]?.detail).toMatchObject({ row: 'anthropic/claude-sonnet-5-5' });
  });
});

describe('a judge file', () => {
  it('that names a model the catalog does not have is rejected, and is not a validator a goal may name', async () => {
    const { bureau, changes } = await open(createMockGenerate([verdict(true)]), {
      'stranger.json': JSON.stringify({
        kind: 'judge',
        description: 'Names no model of ours.',
        model: 'nobody/none',
        rubric: 'Reads well.',
      }),
    });

    await waitUntil(() => bureau.goals.validators().length === 1);
    expect(bureau.goals.validators().map((row) => row.name)).toEqual(['release-notes']);
    expect(
      await bureau.goals.create(goalRequest({ validator: { name: 'stranger', version: '1' } })),
    ).toMatchObject({ outcome: 'rejected', code: 'validator-missing' });
    // Present at start, so the first scan does not report it; an edit that keeps it invalid does.
    expect(changes).toEqual([]);
  });

  it('is reported as rejected through definitions.changed when it is written after start', async () => {
    const { bureau, directory, changes } = await open(createMockGenerate([verdict(true)]));

    await writeFile(
      join(directory, 'stranger.json'),
      JSON.stringify({ kind: 'judge', description: 'x', model: 'nobody/none', rubric: 'r' }),
    );

    await waitUntil(() => changes.some((change) => change.rejected.includes('stranger')));
    expect(changes.find((change) => change.rejected.includes('stranger'))).toMatchObject({
      catalog: 'validators',
    });
    expect(bureau.goals.validators().map((row) => row.name)).toEqual(['release-notes']);
  });
});
