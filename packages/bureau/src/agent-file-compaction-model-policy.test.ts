/**
 * COR-1996 — the model policy binds the summarizer a compacting file agent uses. A step that has to
 * compact with a summarizer the deployment or the Bureau forbids fails with a
 * `ModelPolicyDeniedError` and the summarizer's provider is never called; a write that would save a
 * compacting file over a forbidden summarizer is refused at `compaction`; a scan still lists such a
 * file ready.
 */
import {
  type AgentRunError,
  createModelCatalog,
  type GenerateFunction,
} from '@lostgradient/operative';
import { Conversation } from 'conversationalist';
import { afterEach, describe, expect, it } from 'bun:test';

import { AgentFileError, type AgentFileProblem } from './agent-file';
import { ModelPolicyDeniedError } from './file-agent-generate';
import type { BureauModelPolicyOptions } from './model-policy';
import {
  type AgentFileFixture,
  agentFileText,
  createAgentFileFixture,
  KNOWN_MODEL,
  OTHER_MODEL,
} from './testing/agent-file-fixtures.test-support';

const fixtures: AgentFileFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

const SUMMARIZER_MODEL_NAME = 'claude-opus-5';
const DENY_SUMMARIZER: BureauModelPolicyOptions = {
  bureau: { deniedModels: [SUMMARIZER_MODEL_NAME] },
  policyRevision: 4,
};

const COMPACTING = agentFileText(
  {
    name: 'Compactor',
    model: KNOWN_MODEL,
    tools: '[lookup-order]',
    compaction: '{enabled: true, thresholdPercent: 50}',
  },
  'You are thorough.\n',
);

const LONG_INPUT = 'The customer asks about order twelve. '.repeat(120);
const probe = new Conversation();
probe.appendUserMessage(LONG_INPUT);
/** A window the long input fills to 70%: over a threshold of 50. */
const WINDOW = Math.floor(probe.estimateTokens() / 0.7);

const descriptors = createModelCatalog().descriptors.map((row) =>
  row.provider === 'anthropic' && row.model === 'claude-opus-5-5'
    ? { ...row, contextWindowTokens: WINDOW }
    : row,
);

let policy: BureauModelPolicyOptions | undefined;

async function start(summarizer: GenerateFunction, main: GenerateFunction) {
  policy = undefined;
  const fixture = await createAgentFileFixture({
    watch: false,
    descriptors,
    summarizerModel: OTHER_MODEL,
    modelPolicy: () => policy,
    resolveGenerate: (descriptor) =>
      descriptor.model === SUMMARIZER_MODEL_NAME ? summarizer : main,
  });
  fixtures.push(fixture);
  return fixture;
}

/** A main model that asks for a tool twice then answers, and a summarizer that counts its calls. */
function scripted() {
  let mainCalls = 0;
  let summarizerCalls = 0;
  return {
    summarizerCalls: () => summarizerCalls,
    mainCalls: () => mainCalls,
    main: (async () => {
      mainCalls += 1;
      if (mainCalls > 3) return { content: 'done', toolCalls: [] };
      return {
        content: '',
        toolCalls: [{ id: `call-${mainCalls}`, name: 'lookup-order', arguments: {} }],
      };
    }) as GenerateFunction,
    summarizer: (async () => {
      summarizerCalls += 1;
      return { content: 'SUMMARY', toolCalls: [] };
    }) as GenerateFunction,
  };
}

async function problemOf(work: Promise<unknown>): Promise<AgentFileProblem> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AgentFileError && error.problem !== undefined) return error.problem;
    throw error;
  }
  throw new Error('Expected the write to be refused.');
}

describe('a compacting file agent’s run under a model policy', () => {
  it('fails the step with a ModelPolicyDeniedError when the summarizer is forbidden, and never calls it', async () => {
    const script = scripted();
    const fixture = await start(script.summarizer, script.main);
    await fixture.put('compactor.md', COMPACTING);
    await fixture.catalog.refresh();
    const agent = fixture.catalog.find('compactor');
    if (agent === undefined) throw new Error('Expected the compactor to be ready.');

    // Saved while nothing was forbidden; the policy tightens before the run compacts.
    policy = DENY_SUMMARIZER;
    const result = await agent.run(LONG_INPUT).result();
    const error = result.error as AgentRunError;

    expect(error.kind).toBe('policy');
    expect(error.cause).toBeInstanceOf(ModelPolicyDeniedError);
    expect(error.message).toContain('anthropic/claude-opus-5');
    expect(error.message).toContain('bureau');
    expect(script.summarizerCalls()).toBe(0);
  });

  it('summarizes as before while the summarizer is allowed', async () => {
    const script = scripted();
    const fixture = await start(script.summarizer, script.main);
    await fixture.put('compactor.md', COMPACTING);
    await fixture.catalog.refresh();
    const agent = fixture.catalog.find('compactor');
    if (agent === undefined) throw new Error('Expected the compactor to be ready.');

    policy = { bureau: { deniedModels: ['some-other-model'] }, policyRevision: 5 };
    const result = await agent.run(LONG_INPUT).result();

    expect(result.finishReason).toBe('stop-condition');
    expect(script.summarizerCalls()).toBeGreaterThan(0);
  });
});

describe('a save of a compacting file under a model policy', () => {
  it('refuses to create a compacting file over a forbidden summarizer, naming it at compaction, and writes nothing', async () => {
    const script = scripted();
    const fixture = await start(script.summarizer, script.main);
    policy = DENY_SUMMARIZER;

    const problem = await problemOf(
      fixture.catalog.create('compactor', {
        model: KNOWN_MODEL,
        compaction: { enabled: true },
        instructions: 'Hi.\n',
      }),
    );

    expect(problem.code).toBe('model-policy-denied');
    expect(problem.issues).toMatchObject([
      { path: 'compaction', reference: 'anthropic/claude-opus-5' },
    ]);
    expect(problem.message).toContain('context.summarizerModel');
    expect(await fixture.catalog.read('compactor')).toBeUndefined();
  });

  it('saves a file that does not compact, whatever the summarizer', async () => {
    const script = scripted();
    const fixture = await start(script.summarizer, script.main);
    policy = DENY_SUMMARIZER;

    await fixture.catalog.create('quiet', {
      model: KNOWN_MODEL,
      compaction: { enabled: false },
      instructions: 'Hi.\n',
    });

    expect(fixture.catalog.list()[0]).toMatchObject({ id: 'quiet', state: 'ready' });
  });

  it('saves a compacting file once the summarizer is changed to one the policy allows', async () => {
    const script = scripted();
    const fixture = await start(script.summarizer, script.main);
    policy = DENY_SUMMARIZER;
    fixture.setSummarizerModel(KNOWN_MODEL);

    await fixture.catalog.create('compactor', {
      model: KNOWN_MODEL,
      compaction: { enabled: true },
      instructions: 'Hi.\n',
    });

    expect(fixture.catalog.list()[0]).toMatchObject({ id: 'compactor', state: 'ready' });
  });

  it('still lists a compacting file ready after the policy tightens, since a scan never asks the policy', async () => {
    const script = scripted();
    const fixture = await start(script.summarizer, script.main);
    await fixture.put('compactor.md', COMPACTING);
    policy = DENY_SUMMARIZER;

    await fixture.catalog.refresh();

    expect(fixture.catalog.list()[0]).toMatchObject({ id: 'compactor', state: 'ready' });
    expect(fixture.catalog.find('compactor')).toBeDefined();
  });
});
