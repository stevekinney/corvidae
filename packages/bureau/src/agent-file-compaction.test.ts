/**
 * COR-1866 — an agent file's `compaction`: it is valid only while the deployment has a summarizer
 * model (the `context.summarizerModel` setting), a change to that reaches the catalog, and an
 * enabled file compacts its conversation at the share of the model's context window it names,
 * with the summarizer model and not the agent's own.
 */
import { createModelCatalog, type GenerateFunction } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { Conversation } from 'conversationalist';
import { afterEach, describe, expect, it } from 'bun:test';

import { AgentFileError } from './agent-file';
import { readFileAgentBinding } from './agent-file-catalog';
import { COMPACTION_SYSTEM_PROMPT, transcriptOf } from './file-agent-compaction';
import {
  type AgentFileFixture,
  agentFileText,
  createAgentFileFixture,
  KNOWN_MODEL,
  OTHER_MODEL,
} from './testing/agent-file-fixtures.test-support';
import { startFileBureau, type FileBureauHarness } from './testing/agent-file-bureau.test-support';

const fixtures: AgentFileFixture[] = [];
const harnesses: FileBureauHarness[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

const SUMMARIZER_MODEL_NAME = 'claude-opus-5';
const COMPACTING = agentFileText(
  {
    name: 'Compactor',
    model: KNOWN_MODEL,
    tools: '[lookup-order]',
    compaction: '{enabled: true, thresholdPercent: 50}',
  },
  'You are thorough.\n',
);

/** A long first message and the number of tokens the conversation estimates it at. */
const LONG_INPUT = 'The customer asks about order twelve. '.repeat(120);
function estimatedTokens(text: string): number {
  const probe = new Conversation();
  probe.appendUserMessage(text);
  return probe.estimateTokens();
}

/** The default catalog with the agent's model given a context window of `tokens`. */
function windowOf(tokens: number) {
  return createModelCatalog().descriptors.map((row) =>
    row.provider === 'anthropic' && row.model === 'claude-opus-5-5'
      ? { ...row, contextWindowTokens: tokens }
      : row,
  );
}

interface Scripted {
  readonly main: GenerateFunction;
  readonly summarizer: GenerateFunction;
  readonly summaries: string[];
  readonly mainCalls: () => number;
}

/** An agent that asks for a tool three times then answers, and a summarizer that records what it is shown. */
function scripted(): Scripted {
  let calls = 0;
  const summaries: string[] = [];
  return {
    summaries,
    mainCalls: () => calls,
    main: async () => {
      calls += 1;
      if (calls > 3) return { content: 'done', toolCalls: [] };
      return {
        content: '',
        toolCalls: [{ id: `call-${calls}`, name: 'lookup-order', arguments: {} }],
      };
    },
    summarizer: async ({ conversation }) => {
      summaries.push(
        conversation
          .getMessages()
          .map((message) => (typeof message.content === 'string' ? message.content : ''))
          .join('\n'),
      );
      return { content: 'SUMMARY OF EARLIER WORK', toolCalls: [] };
    },
  };
}

async function start(options: Parameters<typeof createAgentFileFixture>[0] = {}) {
  const fixture = await createAgentFileFixture({ watch: false, ...options });
  fixtures.push(fixture);
  return fixture;
}

describe('compaction needs a summarizer', () => {
  it('lists an enabled file invalid at path compaction while none is configured, and a disabled one ready', async () => {
    const fixture = await start();
    await fixture.put('compactor.md', COMPACTING);
    await fixture.put(
      'quiet.md',
      agentFileText({ model: KNOWN_MODEL, compaction: '{enabled: false}' }),
    );
    await fixture.catalog.refresh();
    const byId = Object.fromEntries(fixture.catalog.list().map((entry) => [entry.id, entry]));
    expect(byId['compactor']).toMatchObject({
      state: 'invalid',
      problem: { code: 'invalid-frontmatter', issues: [{ path: 'compaction' }] },
    });
    expect(byId['compactor']?.problem?.message).toContain('context.summarizerModel');
    expect(byId['quiet']?.state).toBe('ready');
  });

  it('lists an enabled file ready once a summarizer is configured, and invalid again when it is not', async () => {
    const fixture = await start({ summarizerModel: OTHER_MODEL });
    await fixture.put('compactor.md', COMPACTING);
    await fixture.catalog.refresh();
    const revision = fixture.catalog.list()[0]?.definitionRevision;
    expect(fixture.catalog.list()[0]?.state).toBe('ready');

    fixture.setSummarizerModel(undefined);
    const rejected = fixture.nextChange((change) => change.rejected.includes('compactor'));
    await fixture.catalog.revalidate();
    await rejected;
    expect(fixture.catalog.list()[0]).toMatchObject({ state: 'invalid' });
    expect(fixture.catalog.find('compactor')).toBeUndefined();

    fixture.setSummarizerModel(OTHER_MODEL);
    await fixture.catalog.revalidate();
    // The file did not change, so neither did its revision.
    expect(fixture.catalog.list()[0]).toMatchObject({
      state: 'ready',
      definitionRevision: revision,
    });
  });

  it('refuses a write that enables compaction with none configured, and writes nothing', async () => {
    const fixture = await start();
    let thrown: unknown;
    try {
      await fixture.catalog.create('compactor', {
        model: KNOWN_MODEL,
        compaction: { enabled: true },
        instructions: 'Hi.\n',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentFileError);
    expect(thrown).toMatchObject({
      code: 'invalid-frontmatter',
      problem: { issues: [{ path: 'compaction' }] },
    });
    expect(await fixture.catalog.read('compactor')).toBeUndefined();

    fixture.setSummarizerModel(OTHER_MODEL);
    await fixture.catalog.create('compactor', {
      model: KNOWN_MODEL,
      compaction: { enabled: true, thresholdPercent: 80 },
      instructions: 'Hi.\n',
    });
    expect(fixture.catalog.list()[0]).toMatchObject({ id: 'compactor', state: 'ready' });
  });
});

describe('a compaction-enabled file agent’s run', () => {
  async function agentWith(window: number, file: string, script: Scripted) {
    const fixture = await start({
      descriptors: windowOf(window),
      summarizerModel: OTHER_MODEL,
      resolveGenerate: (descriptor) =>
        descriptor.model === SUMMARIZER_MODEL_NAME ? script.summarizer : script.main,
    });
    await fixture.put('compactor.md', file);
    await fixture.catalog.refresh();
    const agent = fixture.catalog.find('compactor');
    if (agent === undefined) throw new Error('Expected the compactor to be ready.');
    return { fixture, agent };
  }

  /** A window the long input fills to 70%: over a threshold of 50, under one of 95. */
  const WINDOW = Math.floor(estimatedTokens(LONG_INPUT) / 0.7);

  it('summarizes the earlier messages with the summarizer model once the threshold is passed', async () => {
    const script = scripted();
    const { agent } = await agentWith(WINDOW, COMPACTING, script);

    const result = await agent.run(LONG_INPUT).result();

    expect(result.finishReason).toBe('stop-condition');
    expect(script.summaries.length).toBeGreaterThan(0);
    expect(script.summaries[0]).toContain(COMPACTION_SYSTEM_PROMPT);
    expect(script.summaries[0]).toContain('order twelve');
    // Only the summarizer model's generate saw the summarizing request, not the agent's own.
    expect(
      result.conversation
        .getMessages()
        .some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('SUMMARY OF EARLIER WORK'),
        ),
    ).toBe(true);
  });

  it('does not compact below the threshold the file names', async () => {
    const script = scripted();
    const { agent } = await agentWith(
      WINDOW,
      agentFileText({
        model: KNOWN_MODEL,
        tools: '[lookup-order]',
        compaction: '{enabled: true, thresholdPercent: 95}',
      }),
      script,
    );
    await agent.run(LONG_INPUT).result();
    expect(script.summaries).toEqual([]);
  });

  it('does not compact when the file turns compaction off, however long the conversation', async () => {
    const script = scripted();
    const { agent } = await agentWith(
      WINDOW,
      agentFileText({
        model: KNOWN_MODEL,
        tools: '[lookup-order]',
        compaction: '{enabled: false, thresholdPercent: 50}',
      }),
      script,
    );
    await agent.run(LONG_INPUT).result();
    expect(script.summaries).toEqual([]);
  });

  it('uses 80 percent when the file names no threshold', async () => {
    const script = scripted();
    const narrow = Math.floor(estimatedTokens(LONG_INPUT) / 0.9);
    const { agent } = await agentWith(
      narrow,
      agentFileText({
        model: KNOWN_MODEL,
        tools: '[lookup-order]',
        compaction: '{enabled: true}',
      }),
      script,
    );
    await agent.run(LONG_INPUT).result();
    expect(script.summaries.length).toBeGreaterThan(0);
  });

  it('carries on without compacting, and says so once, when the summarizer goes away mid-run', async () => {
    const reports: string[] = [];
    const script = scripted();
    const fixture = await start({
      descriptors: windowOf(WINDOW),
      summarizerModel: OTHER_MODEL,
      diagnose: (message) => {
        reports.push(message);
      },
      resolveGenerate: (descriptor) =>
        descriptor.model === SUMMARIZER_MODEL_NAME ? script.summarizer : script.main,
    });
    await fixture.put('compactor.md', COMPACTING);
    await fixture.catalog.refresh();
    const agent = fixture.catalog.find('compactor');
    if (agent === undefined) throw new Error('Expected the compactor to be ready.');

    // The agent was built while a summarizer existed; the setting is unset before the catalog hears.
    fixture.setSummarizerModel(undefined);
    const result = await agent.run(LONG_INPUT).result();

    expect(result.finishReason).toBe('stop-condition');
    expect(script.summaries).toEqual([]);
    expect(reports.filter((report) => report.includes('no summarizer model'))).toHaveLength(1);
  });

  it('still rebuilds from a snapshot when no summarizer is configured, so a recorded run can resume', async () => {
    const script = scripted();
    const { fixture } = await agentWith(WINDOW, COMPACTING, script);
    const detail = await fixture.catalog.detail('compactor');
    fixture.setSummarizerModel(undefined);
    const rebuilt = fixture.catalog.agentFromSnapshot(
      {
        schemaVersion: 1,
        id: 'compactor',
        hash: detail?.definitionHash ?? '',
        firstRunAt: '2026-10-18T00:00:00.000Z',
        lastRunAt: '2026-10-18T00:00:00.000Z',
        definition: detail!.definition!,
      },
      1,
    );
    expect(readFileAgentBinding(rebuilt)?.definition.compaction).toEqual({
      enabled: true,
      thresholdPercent: 50,
    });
  });
});

describe('the transcript the summarizer is shown', () => {
  it('names each message’s role and keeps its text', () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Where is my order?');
    conversation.appendAssistantMessage('Let me look.');
    expect(transcriptOf(conversation.getMessages())).toBe(
      '[user]\nWhere is my order?\n\n[assistant]\nLet me look.',
    );
  });
});

describe('a Bureau with compaction-enabled file agents', () => {
  const rows = createModelCatalog().descriptors;

  async function bureauWith(script: Scripted, catalogRows = rows) {
    const harness = await startFileBureau({
      overrides: {
        models: {
          catalog: catalogRows,
          generate: (descriptor) =>
            descriptor.model === SUMMARIZER_MODEL_NAME ? script.summarizer : script.main,
        },
      },
    });
    harnesses.push(harness);
    await harness.put('compactor.md', COMPACTING);
    await harness.bureau.agents.refresh();
    return harness;
  }

  const stateOf = (harness: FileBureauHarness) =>
    harness.bureau.agents.list().find((listing) => listing.id === 'compactor')?.state;

  it('lists the agent valid as the summarizer setting is set, and invalid when its row is removed', async () => {
    const harness = await bureauWith(scripted());
    expect(stateOf(harness)).toBe('invalid');

    const { revision } = await harness.bureau.settings.get();
    const applied = await harness.bureau.settings.update(
      { 'context.summarizerModel': OTHER_MODEL },
      { expectedRevision: revision },
    );
    expect(applied.outcome).toBe('applied');
    // The setting reaches the catalog without anyone asking for a rescan.
    await waitUntil(() => stateOf(harness) === 'ready');

    harness.bureau.models.replace(rows.filter((row) => row.model !== SUMMARIZER_MODEL_NAME));
    await waitUntil(() => stateOf(harness) === 'invalid');

    harness.bureau.models.replace(rows);
    await waitUntil(() => stateOf(harness) === 'ready');
  });

  it('compacts the conversation of a task that runs on it, through the Bureau’s own run path', async () => {
    const script = scripted();
    const tiny = rows.map((row) =>
      row.provider === 'anthropic' && row.model === 'claude-opus-5-5'
        ? { ...row, contextWindowTokens: Math.floor(estimatedTokens(LONG_INPUT) / 0.7) }
        : row,
    );
    const harness = await bureauWith(script, tiny);
    const { revision } = await harness.bureau.settings.get();
    await harness.bureau.settings.update(
      { 'context.summarizerModel': OTHER_MODEL },
      { expectedRevision: revision },
    );
    await waitUntil(() => stateOf(harness) === 'ready');

    const run = await harness.bureau.tasks.start('compactor', LONG_INPUT);
    const result = await run.result();

    expect(result.finishReason).toBe('stop-condition');
    expect(script.mainCalls()).toBe(4);
    expect(script.summaries.length).toBeGreaterThan(0);
  });
});
