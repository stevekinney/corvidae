/**
 * COR-1529 — the tools an agent manages its workflows with, run by a real file agent over a real
 * Bureau: which agents are offered them, who they act for (the run's owner of record, with two
 * principals), the identifier a name becomes, every result shape as an ordinary tool result, and
 * the `agent` field of what they write.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createToolbox, readToolShortDescription, type Tool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import { BureauError, createBureau } from './create-bureau';
import { lookupTool } from './testing/agent-file-fixtures.test-support';
import {
  startWorkflowToolsBureau,
  type WorkflowToolsHarness,
} from './testing/workflow-tools-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import {
  createWorkflowTools,
  deriveWorkflowIdentifier,
  WORKFLOW_TOOL_NAMES,
} from './workflow-tools';
import { agentFileDirectory } from './sources/agent-file-directory';
import { workflowFileDirectory } from './sources/workflow-file-directory';
import { MemoryStorage } from '@lostgradient/storage';

const harnesses: WorkflowToolsHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
});

async function start(options?: Parameters<typeof startWorkflowToolsBureau>[0]) {
  const harness = await startWorkflowToolsBureau(options);
  harnesses.push(harness);
  return harness;
}

const TRIGGER = { kind: 'schedule', spec: '1h' };
const STEPS = [
  { kind: 'activity', handler: 'agent', input: { agent: 'scribe', message: 'Write the digest' } },
];

async function fileOf(harness: WorkflowToolsHarness, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(harness.workflowsPath, `${id}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

async function scheduleStatus(harness: WorkflowToolsHarness): Promise<string | undefined> {
  const detail = await harness.bureau.workflows!.get('digest');
  return detail?.schedule?.status;
}

function hashOf(harness: WorkflowToolsHarness, id: string): string {
  return harness.bureau.workflows!.list().find((entry) => entry.id === id)!.hash!;
}

/** The workflow tools in an offered set: Bureau's own `requestHumanInput` rides beside them. */
function workflowToolsOf(offered: readonly string[] | undefined): string[] {
  return (offered ?? []).filter((name) => name.startsWith('workflows-'));
}

describe('which agents are offered the tools', () => {
  it('offers an agent file the tools it lists, and no others', async () => {
    const harness = await start({ agents: [] });
    await harness.putAgent('lister', ['workflows-list']);
    await harness.putAgent('bare', []);
    await harness.callTool('workflows-list', {}, { agent: 'lister' });
    const listerOffered = workflowToolsOf(harness.offered.at(-1));
    // The agent that lists none is offered none, so it makes no call, but its model is still asked.
    const bareCall = await harness.callTool('workflows-list', {}, { agent: 'bare' });
    expect(bareCall.outcome).not.toBe('success');
    expect(listerOffered).toEqual(['workflows-list']);
    expect(workflowToolsOf(harness.offered.at(-1))).toEqual([]);
  });

  it('names the five tools with hyphens, and lists them in the deployment’s tool catalog', async () => {
    expect([...WORKFLOW_TOOL_NAMES]).toEqual([
      'workflows-create',
      'workflows-update',
      'workflows-pause',
      'workflows-resume',
      'workflows-list',
    ]);
    const harness = await start();
    await harness.callTool('workflows-list', {});
    expect(workflowToolsOf(harness.offered[0])).toEqual([...WORKFLOW_TOOL_NAMES].toSorted());
  });

  it('refuses a host tool with one of their names at createBureau, with BAD_REQUEST', async () => {
    for (const name of WORKFLOW_TOOL_NAMES) {
      const error = await createBureau({
        agents: {},
        agentSource: agentFileDirectory('/nonexistent', { tools: { [name]: lookupTool } }),
        workflowSource: workflowFileDirectory('/nonexistent-workflows'),
        models: { generate: () => async () => ({ content: '', toolCalls: [] }) },
        storage: new MemoryStorage(),
        durable: true,
      }).then(
        (bureau) => (bureau.dispose(), undefined),
        (failure: unknown) => failure,
      );
      expect(error, name).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('BAD_REQUEST');
      expect((error as BureauError).message).toContain(name);
    }
  });

  it('accepts the same host tool name when no workflow directory is set', async () => {
    const bureau = await createBureau({
      agents: {},
      agentSource: agentFileDirectory('/nonexistent', { tools: { 'workflows-list': lookupTool } }),
      models: { generate: () => async () => ({ content: '', toolCalls: [] }) },
      storage: new MemoryStorage(),
      durable: true,
    });
    await bureau.dispose();
  });
});

describe('deriving an identifier from a name', () => {
  it('lowercases, turns every run of other characters into one hyphen, and trims hyphens', () => {
    for (const [name, id] of [
      ['Nightly Digest', 'nightly-digest'],
      ['  --Hello__World--  ', 'hello-world'],
      ['a   b...c', 'a-b-c'],
      ['Ünï Cödé', 'n-c-d'],
      ['x', 'x'],
      ['digest 2', 'digest-2'],
    ] as const) {
      expect(deriveWorkflowIdentifier(name), name).toEqual({ id });
    }
  });

  it('refuses a name with nothing to make an identifier from, one that starts with a digit, and one that is too long', () => {
    for (const name of ['', '   ', '!!!', '日本語', '2nd digest', '-9']) {
      expect(deriveWorkflowIdentifier(name), name).toHaveProperty('message');
    }
    expect(deriveWorkflowIdentifier('a'.repeat(64))).toEqual({ id: 'a'.repeat(64) });
    expect(deriveWorkflowIdentifier('a'.repeat(65))).toHaveProperty('message');
  });
});

describe('workflows-create', () => {
  it('writes a file owned by the calling agent, active as the call returns, and derives the identifier', async () => {
    const harness = await start();

    const { result, outcome } = await harness.callTool('workflows-create', {
      name: 'Nightly Digest!',
      trigger: TRIGGER,
      steps: STEPS,
    });

    expect(outcome).toBe('success');
    const hash = hashOf(harness, 'nightly-digest');
    expect(result).toEqual({ status: 'ok', id: 'nightly-digest', hash });
    expect(await fileOf(harness, 'nightly-digest')).toMatchObject({
      name: 'nightly-digest',
      agent: 'scribe',
      trigger: TRIGGER,
    });
    // Active at once: registered with the engine, and its schedule exists and runs.
    const detail = await harness.bureau.workflows!.get('nightly-digest');
    expect(detail?.state).toBe('ready');
    expect(detail?.schedule?.status).toBe('active');
  });

  it('writes the description it is given, and none when it is left out', async () => {
    const harness = await start();

    await harness.callTool('workflows-create', {
      name: 'Described',
      description: 'Writes the nightly digest.',
      trigger: TRIGGER,
      steps: STEPS,
    });
    await harness.callTool('workflows-create', { name: 'Bare', trigger: TRIGGER, steps: STEPS });

    expect(await fileOf(harness, 'described')).toMatchObject({
      description: 'Writes the nightly digest.',
    });
    expect(await fileOf(harness, 'bare')).not.toHaveProperty('description');
    expect(harness.bureau.workflows!.list().map((listing) => listing.description)).toEqual([
      null,
      'Writes the nightly digest.',
    ]);
  });

  it('takes an explicit identifier, and answers a taken one as a conflict naming it, with no suffix', async () => {
    const harness = await start();
    const first = await harness.callTool('workflows-create', {
      name: 'Anything',
      id: 'digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    expect(first.result).toMatchObject({ status: 'ok', id: 'digest' });

    const taken = await harness.callTool('workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    expect(taken.outcome).toBe('success');
    expect(taken.result).toMatchObject({
      status: 'conflict',
      id: 'digest',
      reason: 'workflow-file-exists',
    });
    expect(harness.bureau.workflows!.list().map((entry) => entry.id)).toEqual(['digest']);
  });

  it('answers a name that cannot be an identifier as invalid-identifier, and writes nothing', async () => {
    const harness = await start();
    for (const name of ['!!!', '9 lives', 'x'.repeat(65)]) {
      const { result, outcome } = await harness.callTool('workflows-create', {
        name,
        trigger: TRIGGER,
        steps: STEPS,
      });
      expect(outcome, name).toBe('success');
      expect(result, name).toMatchObject({ status: 'invalid', code: 'invalid-identifier' });
    }
    expect(harness.bureau.workflows!.list()).toEqual([]);
  });

  it('answers an explicit identifier that is not valid as invalid-identifier', async () => {
    const harness = await start();
    const { result } = await harness.callTool('workflows-create', {
      name: 'Digest',
      id: 'Bad_Id',
      trigger: TRIGGER,
      steps: STEPS,
    });
    expect(result).toMatchObject({ status: 'invalid', code: 'invalid-identifier' });
    expect(harness.bureau.workflows!.list()).toEqual([]);
  });

  it('answers a document that would not load with its issues as the tool result, not as a failure', async () => {
    const harness = await start();
    const { result, outcome } = await harness.callTool('workflows-create', {
      name: 'Broken',
      trigger: { kind: 'schedule', spec: 'not a schedule' },
      steps: [{ kind: 'activity', handler: 'nobody' }],
    });
    expect(outcome).toBe('success');
    expect(result).toMatchObject({ status: 'invalid', code: 'invalid-document' });
    const issues = (result as { issues: Array<{ path: string; message: string }> }).issues;
    expect(issues.map((issue) => issue.path).toSorted()).toEqual(['steps[0].handler', 'trigger']);
    expect(harness.bureau.workflows!.list()).toEqual([]);
  });

  it('creates a workflow that is paused when it says so, and a signal-triggered one', async () => {
    const harness = await start();
    await harness.callTool('workflows-create', {
      name: 'Listener',
      trigger: { kind: 'signal', name: 'go' },
      steps: STEPS,
      paused: true,
    });
    expect(harness.bureau.workflows!.list()[0]).toMatchObject({
      id: 'listener',
      paused: true,
      triggerKind: 'signal',
    });
  });
});

describe('what a model is shown of a tool’s input', () => {
  // The providers build their requests through the toolbox's adapters, which read each tool's
  // `input` schema; a tool's own `toJSON()` is not what a model sees.
  const tools = () =>
    createToolbox(
      Object.values(
        createWorkflowTools({
          workflows: () => undefined,
          runIdentity: async () => ({ agent: undefined, owner: undefined }),
        }),
      ),
    );

  it.each([
    ['workflows-create', ['name', 'trigger', 'steps']],
    ['workflows-update', ['id', 'expectedHash', 'trigger', 'steps']],
    ['workflows-pause', ['id', 'expectedHash']],
    ['workflows-resume', ['id', 'expectedHash']],
  ] as const)(
    'is the real schema for %s, through both provider adapters',
    async (name, required) => {
      const anthropicTools = await tools().toAnthropicTools();
      const openaiTools = await tools().toOpenAITools();
      const anthropic = anthropicTools.find((tool) => tool.name === name);
      const openai = openaiTools.find((tool) => tool.function.name === name);
      expect(anthropic?.input_schema).toMatchObject({
        required: expect.arrayContaining([...required]),
      });
      expect(openai?.function.parameters).toMatchObject({
        required: expect.arrayContaining([...required]),
      });
    },
  );
});

describe('workflows-update, workflows-pause, workflows-resume', () => {
  async function seeded() {
    const harness = await start({ agents: ['scribe', 'editor'] });
    await harness.callTool('workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    return harness;
  }

  it('update replaces the definition and makes the caller the agent that wrote it', async () => {
    const harness = await seeded();
    const { result } = await harness.callTool(
      'workflows-update',
      {
        id: 'digest',
        expectedHash: hashOf(harness, 'digest'),
        trigger: { kind: 'schedule', spec: '2h' },
        steps: STEPS,
      },
      { agent: 'editor' },
    );
    expect(result).toEqual({ status: 'ok', id: 'digest', hash: hashOf(harness, 'digest') });
    expect(await fileOf(harness, 'digest')).toMatchObject({
      agent: 'editor',
      trigger: { kind: 'schedule', spec: '2h' },
    });
    expect(await scheduleStatus(harness)).toBe('active');
  });

  it('pause and resume change only paused, and leave the agent that wrote the file', async () => {
    const harness = await seeded();
    const before = await fileOf(harness, 'digest');

    const paused = await harness.callTool(
      'workflows-pause',
      { id: 'digest', expectedHash: hashOf(harness, 'digest') },
      { agent: 'editor' },
    );
    expect(paused.result).toMatchObject({ status: 'ok', id: 'digest' });
    expect(await fileOf(harness, 'digest')).toEqual({ ...before, paused: true });
    expect(await scheduleStatus(harness)).toBe('paused');

    const resumed = await harness.callTool(
      'workflows-resume',
      { id: 'digest', expectedHash: hashOf(harness, 'digest') },
      { agent: 'editor' },
    );
    expect(resumed.result).toMatchObject({ status: 'ok', id: 'digest' });
    expect(await fileOf(harness, 'digest')).toEqual({ ...before, paused: false });
    expect(await scheduleStatus(harness)).toBe('active');
  });

  it('answers a stale expectedHash as a conflict that names the identifier and the hash now on disk', async () => {
    const harness = await seeded();
    const stale = hashOf(harness, 'digest');
    await harness.bureau.workflows!.update(
      'digest',
      { agent: 'scribe', trigger: { kind: 'schedule', spec: '3h' }, steps: STEPS },
      { expectedHash: stale },
    );
    const current = hashOf(harness, 'digest');
    for (const [tool, args] of [
      ['workflows-update', { trigger: TRIGGER, steps: STEPS }],
      ['workflows-pause', {}],
      ['workflows-resume', {}],
    ] as const) {
      const { result, outcome } = await harness.callTool(tool, {
        id: 'digest',
        expectedHash: stale,
        ...args,
      });
      expect(outcome, tool).toBe('success');
      expect(result, tool).toEqual({
        status: 'conflict',
        id: 'digest',
        reason: 'workflow-file-changed',
        currentHash: current,
      });
    }
    expect(hashOf(harness, 'digest')).toBe(current);
  });

  it('answers a workflow that does not exist as not-found', async () => {
    const harness = await start();
    for (const [tool, args] of [
      ['workflows-update', { trigger: TRIGGER, steps: STEPS }],
      ['workflows-pause', {}],
      ['workflows-resume', {}],
    ] as const) {
      const { result } = await harness.callTool(tool, {
        id: 'nobody',
        expectedHash: 'abc',
        ...args,
      });
      expect(result, tool).toEqual({ status: 'not-found', id: 'nobody' });
    }
  });

  it('answers an update that would not load as invalid, and leaves the file as it was', async () => {
    const harness = await seeded();
    const before = await readFile(join(harness.workflowsPath, 'digest.json'), 'utf8');
    const { result } = await harness.callTool('workflows-update', {
      id: 'digest',
      expectedHash: hashOf(harness, 'digest'),
      trigger: { kind: 'webhook' },
      steps: STEPS,
    });
    expect(result).toMatchObject({ status: 'invalid', code: 'invalid-document' });
    expect(await readFile(join(harness.workflowsPath, 'digest.json'), 'utf8')).toBe(before);
  });
});

describe('workflows-list', () => {
  it('lists each workflow with its hash, state, paused, and trigger kind, and a broken file with its problem', async () => {
    const harness = await start();
    await harness.callTool('workflows-create', { name: 'Digest', trigger: TRIGGER, steps: STEPS });
    await harness.callTool('workflows-create', {
      name: 'Listener',
      trigger: { kind: 'signal', name: 'go' },
      steps: STEPS,
      paused: true,
    });
    await Bun.write(join(harness.workflowsPath, 'broken.json'), '{ not json');
    await harness.bureau.workflows!.refresh();

    const { result } = await harness.callTool('workflows-list', {});

    expect(result).toEqual({
      status: 'ok',
      workflows: [
        {
          id: 'broken',
          hash: hashOf(harness, 'broken'),
          state: 'invalid',
          paused: false,
          triggerKind: null,
          description: null,
          problem: 'invalid-json',
        },
        {
          id: 'digest',
          hash: hashOf(harness, 'digest'),
          state: 'ready',
          paused: false,
          triggerKind: 'schedule',
          description: null,
          problem: null,
        },
        {
          id: 'listener',
          hash: hashOf(harness, 'listener'),
          state: 'ready',
          paused: true,
          triggerKind: 'signal',
          description: null,
          problem: null,
        },
      ],
    });
  });

  it('lists the description, so an agent can pass it back and keep it through an update', async () => {
    const harness = await start();
    await harness.callTool('workflows-create', {
      name: 'Digest',
      description: 'Writes the daily digest.',
      trigger: TRIGGER,
      steps: STEPS,
    });
    const listing = await harness.callTool('workflows-list', {});
    const listed = listing.result as {
      workflows: Array<{ id: string; hash: string; description: string | null }>;
    };
    expect(listed.workflows).toMatchObject([
      { id: 'digest', description: 'Writes the daily digest.' },
    ]);

    const { result } = await harness.callTool('workflows-update', {
      id: 'digest',
      expectedHash: listed.workflows[0]!.hash,
      description: listed.workflows[0]!.description,
      trigger: TRIGGER,
      steps: STEPS,
    });
    expect(result).toMatchObject({ status: 'ok' });
    const afterListing = await harness.callTool('workflows-list', {});
    const after = afterListing.result as {
      workflows: Array<{ description: string | null }>;
    };
    expect(after.workflows[0]?.description).toBe('Writes the daily digest.');
  });

  it('tells the model that an update replaces the whole definition, description included', () => {
    const tools = createWorkflowTools({
      workflows: () => undefined,
      runIdentity: async () => ({ agent: undefined, owner: undefined }),
    });
    expect(tools['workflows-update']?.description).toContain('description included');
    expect(tools['workflows-list']?.description).toContain('description');
  });

  it('hands the hash it lists to the tools that change a file', async () => {
    const harness = await start();
    await harness.callTool('workflows-create', { name: 'Digest', trigger: TRIGGER, steps: STEPS });
    const called = await harness.callTool('workflows-list', {});
    const listed = called.result as { workflows: Array<{ id: string; hash: string }> };
    const { result } = await harness.callTool('workflows-pause', {
      id: 'digest',
      expectedHash: listed.workflows[0]!.hash,
    });
    expect(result).toMatchObject({ status: 'ok' });
  });
});

describe('who the tools act for', () => {
  async function withWorkflow() {
    const harness = await start();
    await harness.callTool('workflows-create', { name: 'Digest', trigger: TRIGGER, steps: STEPS });
    return harness;
  }

  it('lists nothing and answers every write as not-found for a run another principal owns, and changes nothing', async () => {
    const harness = await withWorkflow();
    const principal = 'api-key:alice';
    const before = await readFile(join(harness.workflowsPath, 'digest.json'), 'utf8');
    const hash = hashOf(harness, 'digest');

    const listed = await harness.callTool('workflows-list', {}, { principal });
    expect(listed.outcome).toBe('success');
    expect(listed.result).toEqual({ status: 'ok', workflows: [] });

    for (const [tool, args, id] of [
      ['workflows-create', { name: 'Intruder', trigger: TRIGGER, steps: STEPS }, 'intruder'],
      [
        'workflows-update',
        { id: 'digest', expectedHash: hash, trigger: TRIGGER, steps: STEPS },
        'digest',
      ],
      ['workflows-pause', { id: 'digest', expectedHash: hash }, 'digest'],
      ['workflows-resume', { id: 'digest', expectedHash: hash }, 'digest'],
    ] as const) {
      const { result, outcome } = await harness.callTool(tool, args, { principal });
      expect(outcome, tool).toBe('success');
      expect(result, tool).toEqual({ status: 'not-found', id });
    }

    expect(await readFile(join(harness.workflowsPath, 'digest.json'), 'utf8')).toBe(before);
    expect(harness.bureau.workflows!.list().map((entry) => entry.id)).toEqual(['digest']);
  });

  it('acts for a run whose owner of record is the deployment’s, and not for one that merely says so', async () => {
    const harness = await withWorkflow();
    // `anonymous:local` is the deployment's owner of record: the default for a run with no principal,
    // and also what an explicit principal of that name is.
    const asOwner = await harness.callTool('workflows-list', {}, { principal: 'anonymous:local' });
    expect((asOwner.result as { workflows: unknown[] }).workflows).toHaveLength(1);
    const asDefault = await harness.callTool('workflows-list', {});
    expect((asDefault.result as { workflows: unknown[] }).workflows).toHaveLength(1);
  });

  it('answers a call made with no run behind it as not-found', async () => {
    const harness = await withWorkflow();
    const tools = createWorkflowTools({
      workflows: () => harness.bureau.workflows,
      runIdentity: async () => ({ agent: 'scribe', owner: harness.bureau.workflows!.owner }),
    });
    const answer = await (
      tools['workflows-list'] as unknown as {
        execute: (input: unknown, context: unknown) => Promise<unknown>;
      }
    ).execute({}, {});
    expect(answer).toEqual({ status: 'ok', workflows: [] });
  });
});

describe('a chat session run', () => {
  it('acts as the session’s principal and agent, the same as a catalog run', async () => {
    const harness = await start();
    await harness.callTool('workflows-create', { name: 'Digest', trigger: TRIGGER, steps: STEPS });

    const asOwner = await harness.callTool('workflows-list', {}, { via: 'session' });
    expect((asOwner.result as { workflows: unknown[] }).workflows).toHaveLength(1);

    const asAlice = await harness.callTool(
      'workflows-list',
      {},
      { via: 'session', principal: 'api-key:alice' },
    );
    expect(asAlice.result).toEqual({ status: 'ok', workflows: [] });

    const created = await harness.callTool(
      'workflows-create',
      { name: 'From chat', trigger: TRIGGER, steps: STEPS },
      { via: 'session' },
    );
    expect(created.result).toMatchObject({ status: 'ok', id: 'from-chat' });
    expect(await fileOf(harness, 'from-chat')).toMatchObject({ agent: 'scribe' });
  });
});

describe('a calling agent whose identifier is not an agent identifier', () => {
  it('gets invalid-agent from every tool and writes nothing', async () => {
    const harness = await start();
    await harness.callTool('workflows-create', { name: 'Digest', trigger: TRIGGER, steps: STEPS });
    const before = await readFile(join(harness.workflowsPath, 'digest.json'), 'utf8');
    const hash = hashOf(harness, 'digest');
    const tools = createWorkflowTools({
      workflows: () => harness.bureau.workflows,
      runIdentity: async () => ({ agent: 'Not An Agent', owner: harness.bureau.workflows!.owner }),
    });
    const run = (name: string, input: unknown) =>
      (
        tools[name] as unknown as {
          execute: (input: unknown, context: unknown) => Promise<unknown>;
        }
      ).execute(input, { executionContext: { parentRunId: 'run-1' } });

    const results = [
      await run('workflows-create', { name: 'Other', trigger: TRIGGER, steps: STEPS }),
      await run('workflows-update', {
        id: 'digest',
        expectedHash: hash,
        trigger: TRIGGER,
        steps: STEPS,
      }),
      await run('workflows-pause', { id: 'digest', expectedHash: hash }),
      await run('workflows-resume', { id: 'digest', expectedHash: hash }),
      await run('workflows-list', {}),
    ];

    for (const result of results) {
      expect(result).toMatchObject({ status: 'invalid', code: 'invalid-agent' });
      expect((result as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
    }
    expect(await readFile(join(harness.workflowsPath, 'digest.json'), 'utf8')).toBe(before);
    expect(harness.bureau.workflows!.list().map((entry) => entry.id)).toEqual(['digest']);
  });
});

describe('a file written by hand', () => {
  it('is listed and can be paused by an agent that did not write it', async () => {
    const harness = await start();
    await Bun.write(
      join(harness.workflowsPath, 'by-hand.json'),
      workflowFileText('by-hand', { agent: 'someone' }),
    );
    await harness.bureau.workflows!.refresh();
    const { result } = await harness.callTool('workflows-pause', {
      id: 'by-hand',
      expectedHash: hashOf(harness, 'by-hand'),
    });
    expect(result).toMatchObject({ status: 'ok', id: 'by-hand' });
    expect(await fileOf(harness, 'by-hand')).toMatchObject({ agent: 'someone', paused: true });
  });
});

describe('what a person is shown of each tool', () => {
  it('is one line of at most 120 characters per tool, apart from the prompt the model reads', () => {
    const tools: Record<string, Tool> = createWorkflowTools({
      workflows: () => undefined,
      runIdentity: async () => ({ agent: undefined, owner: undefined }),
    });
    for (const name of WORKFLOW_TOOL_NAMES) {
      const line = readToolShortDescription(tools[name]?.metadata);
      expect(line, name).toBeDefined();
      expect(line?.length, name).toBeLessThanOrEqual(120);
      expect(line, name).not.toBe(tools[name]?.description);
    }
  });
});
