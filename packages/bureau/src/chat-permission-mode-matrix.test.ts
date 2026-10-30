/**
 * COR-1947 — a chat's permission mode is in force for every agent kind and every tool a run holds,
 * not only a file agent's own listed tools. Each row of the table states what a call does: every
 * agent kind, in every mode, for a tool that reads, a tool that changes something, and each tool
 * Bureau adds to a run. The table is written out as data, and every cell is a real call in a real
 * chat, steered over HTTP as a client steers one.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox } from 'armorer';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureauHandler } from './http/create-bureau-handler';
import { authentication, OWNER, rpc } from './http/management/management-fixtures.test-support';
import { agentFileDirectory } from './sources/agent-file-directory';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { createToolApprovalHooks, decideChatPermission } from './tool-approval';
import type { Bureau } from './types';

const SECRET = 'permission-mode-matrix-secret';
const executed: string[] = [];

const orderTool = (name: string, metadata: { readOnly: true } | { mutates: true }) =>
  createTool({
    name,
    version: '1.0.0',
    description: name,
    input: z.object({}),
    metadata,
    execute: async () => {
      executed.push(name);
      return { ok: name };
    },
  });

const readOrder = orderTool('read-order', { readOnly: true });
const issueRefund = orderTool('issue-refund', { mutates: true });
const OWN_TOOLS = [readOrder, issueRefund];
const OWN_TOOL_NAMES = OWN_TOOLS.map((tool) => tool.name);

/** The tool calls of the model's next steps, in order; an empty queue answers `Done.`. */
const steps: Array<
  () => { name: string; arguments: object } | Promise<{ name: string; arguments: object }>
> = [];
/** The result text of the last tool call the model was shown. */
let lastToolResult: string | undefined;

/** The model of every agent here: it reads the result it was shown, then takes its next step. */
const generate: GenerateFunction = async ({ conversation }) => {
  const result = conversation.getMessages().findLast((message) => message.toolResult)?.toolResult;
  if (result !== undefined) lastToolResult = JSON.stringify(result.content);
  const next = await steps.shift()?.();
  return next === undefined
    ? { content: 'Done.', toolCalls: [] }
    : { content: '', toolCalls: [{ name: next.name, arguments: next.arguments }] };
};

const parksOnApproval = [stopWhen.pendingApproval(), stopWhen.noToolCalls()];

const AGENTS = {
  // A code agent whose toolbox has no opinion of its own about approvals.
  coder: createAgent({
    name: 'coder',
    generate,
    toolbox: createToolbox(OWN_TOOLS, { approvalSecret: SECRET }),
    stopWhen: parksOnApproval,
  }),
  // Built as Interborough seeds `tool-runner`: the same rule a file agent's tools follow.
  runner: createAgent({
    name: 'runner',
    generate,
    toolbox: createToolbox(OWN_TOOLS, {
      approvalSecret: SECRET,
      policy: createToolApprovalHooks(undefined, { tools: OWN_TOOL_NAMES }),
    }),
    stopWhen: parksOnApproval,
  }),
  // A toolbox with an approval policy of its own, which `always` must not put to a person twice.
  guarded: createAgent({
    name: 'guarded',
    generate,
    toolbox: createToolbox(OWN_TOOLS, {
      approvalSecret: SECRET,
      approvalPolicy: { mode: 'on-mutation' },
    }),
    stopWhen: parksOnApproval,
  }),
  // A code agent that does not stop on an approval.
  unstopped: createAgent({
    name: 'unstopped',
    generate,
    toolbox: createToolbox(OWN_TOOLS, { approvalSecret: SECRET }),
  }),
  // A host's own tool under the name Bureau's asking tool has, which changes something.
  impostor: createAgent({
    name: 'impostor',
    generate,
    toolbox: createToolbox(
      [
        createTool({
          name: 'requestHumanInput',
          version: '1.0.0',
          description: 'Not the one Bureau adds.',
          input: z.object({}),
          metadata: { mutates: true },
          execute: async () => {
            executed.push('impostor');
            return { ok: true };
          },
        }),
      ],
      { approvalSecret: SECRET },
    ),
    stopWhen: parksOnApproval,
  }),
};

type Outcome = 'runs' | 'asks' | 'denied';
const KINDS = ['helper', 'coder', 'runner'] as const;
type Kind = (typeof KINDS)[number] | Exclude<keyof typeof AGENTS, 'coder' | 'runner'>;
const MODES = ['on-changes', 'always', 'allow-all', 'read-only'] as const;
type Mode = (typeof MODES)[number];
const TOOLS = [
  'read-order',
  'issue-refund',
  'requestHumanInput',
  'scheduleWakeup',
  'decide',
] as const;
type ToolName = (typeof TOOLS)[number];

/** One outcome for each of {@link TOOLS}, in order. */
type Row = readonly [Outcome, Outcome, Outcome, Outcome, Outcome];

/**
 * The required result of every cell. `requestHumanInput` only asks a person something, so no mode
 * stands between it and that person. `scheduleWakeup` schedules work, so it is a change: `read-only`
 * denies it. `decide` asks a model a question and changes nothing, so it is a read. The two ask in
 * `always`, like any tool. In `on-changes` the tool's own setting decides, and a code agent whose
 * toolbox says nothing lets a change through, as it always has.
 */
const TABLE: Readonly<Record<(typeof KINDS)[number], Readonly<Record<Mode, Row>>>> = {
  helper: {
    'on-changes': ['runs', 'asks', 'runs', 'runs', 'runs'],
    always: ['asks', 'asks', 'runs', 'asks', 'asks'],
    'allow-all': ['runs', 'runs', 'runs', 'runs', 'runs'],
    'read-only': ['runs', 'denied', 'runs', 'denied', 'runs'],
  },
  coder: {
    'on-changes': ['runs', 'runs', 'runs', 'runs', 'runs'],
    always: ['asks', 'asks', 'runs', 'asks', 'asks'],
    'allow-all': ['runs', 'runs', 'runs', 'runs', 'runs'],
    'read-only': ['runs', 'denied', 'runs', 'denied', 'runs'],
  },
  runner: {
    'on-changes': ['runs', 'asks', 'runs', 'runs', 'runs'],
    always: ['asks', 'asks', 'runs', 'asks', 'asks'],
    'allow-all': ['runs', 'runs', 'runs', 'runs', 'runs'],
    'read-only': ['runs', 'denied', 'runs', 'denied', 'runs'],
  },
};

const ARGUMENTS: Readonly<Record<ToolName, object>> = {
  'read-order': {},
  'issue-refund': {},
  requestHumanInput: { signalName: 'answer', prompt: 'Which?' },
  scheduleWakeup: { in: 1 },
  decide: { kind: 'boolean', question: 'Well?' },
};

let harness: FileBureauHarness;
let bureau: Bureau;
let directory: string;
let steer: (contextId: string, commandId: string, mode: Mode) => Promise<void>;
let commands = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bureau-permission-matrix-'));
  harness = await startFileBureau({
    directory,
    agents: AGENTS,
    overrides: {
      id: 'permission-matrix-bureau',
      agentApprovalSecret: SECRET,
      agentSource: agentFileDirectory(directory, {
        tools: { 'read-order': readOrder, 'issue-refund': issueRefund },
      }),
      decisions: {
        models: {
          host: {
            name: 'scripted/model',
            kinds: new Set(['boolean' as const]),
            decide: async () => ({ value: true, provider: 'scripted', model: 'model' }),
          },
        },
        model: 'host',
      },
      models: { generate: () => generate },
    },
  });
  bureau = harness.bureau;
  await harness.put(
    'helper.md',
    agentFileText({ model: KNOWN_MODEL, tools: '[read-order, issue-refund]' }),
  );
  await bureau.agents.refresh();
  const handler = createBureauHandler(bureau, { authentication });
  steer = async (contextId, commandId, mode) => {
    const body = await rpc(
      handler,
      'bureau.contexts.steer',
      { contextId, commandId, permissionMode: mode },
      'alice-key',
    );
    expect(body.result).toMatchObject({ outcome: 'accepted' });
  };
});

afterAll(async () => {
  await harness.dispose();
  await rm(directory, { recursive: true, force: true });
});

beforeEach(() => {
  executed.length = 0;
  steps.length = 0;
  lastToolResult = undefined;
});

const reviewsOf = (runId: string) =>
  bureau.reviews.list().filter((review) => review.runId === runId);

/** A chat of `kind` that has answered one message, so it can be steered. */
async function openChat(kind: Kind, mode: Mode): Promise<string> {
  const task = await bureau.tasks.start(kind, 'Hello.', { principal: OWNER.alice });
  await task.result();
  commands += 1;
  await steer(task.contextId, `steer-${commands}`, mode);
  return task.contextId;
}

/** What one call of `tool` does in the chat `contextId`. */
async function outcomeOf(kind: Kind, contextId: string, tool: ToolName): Promise<Outcome> {
  steps.push(() => ({ name: tool, arguments: ARGUMENTS[tool] }));
  const task = await bureau.tasks.start(kind, 'Go.', { principal: OWNER.alice, contextId });
  // The model is shown a result once the call is decided, and a call that parks has a review.
  await waitUntil(() => reviewsOf(task.id).length > 0 || lastToolResult !== undefined, {
    message: `the ${tool} call to be decided`,
  });
  const [review] = reviewsOf(task.id);
  if (review !== undefined) {
    return review.kind === 'tool-approval' ? 'asks' : 'runs';
  }
  await task.result();
  return lastToolResult?.includes('denied') === true ? 'denied' : 'runs';
}

describe('a chat’s permission mode, for every agent kind and tool (COR-1947)', () => {
  for (const kind of KINDS) {
    for (const mode of MODES) {
      for (const [index, tool] of TOOLS.entries()) {
        const expected = TABLE[kind][mode][index] as Outcome;
        it(`${kind} in ${mode}: ${tool} ${expected}`, async () => {
          const contextId = await openChat(kind, mode);
          expect(await outcomeOf(kind, contextId, tool)).toBe(expected);
          const ownTool = tool === 'read-order' || tool === 'issue-refund';
          if (ownTool) expect(executed).toEqual(expected === 'runs' ? [tool] : []);
        });
      }
    }
  }
});

/** The one pending tool approval of a run. */
function approvalOf(runId: string) {
  const [review] = reviewsOf(runId);
  if (review?.kind !== 'tool-approval') throw new Error('Expected a tool approval.');
  return review;
}

/** Starts a run whose model calls `tool` once, and returns it once the run has ended. */
async function callIn(kind: Kind, contextId: string, tool: ToolName) {
  steps.push(() => ({ name: tool, arguments: ARGUMENTS[tool] }));
  const task = await bureau.tasks.start(kind, 'Go.', { principal: OWNER.alice, contextId });
  await task.result();
  return task;
}

const approve = (id: string, remember = false) =>
  bureau.reviews.resolve({
    id,
    decision: 'approve',
    principal: 'api-key:bob',
    ...(remember ? { remember: true } : {}),
  });

describe('a change of mode (COR-1947)', () => {
  it('is in force at the next call of a code agent’s live run', async () => {
    const contextId = await openChat('coder', 'on-changes');
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    steps.push(
      () => ({ name: 'read-order', arguments: {} }),
      async () => {
        entered.resolve();
        await released.promise;
        return { name: 'issue-refund', arguments: {} };
      },
    );
    const task = await bureau.tasks.start('coder', 'Go.', { principal: OWNER.alice, contextId });
    await entered.promise;

    await steer(contextId, 'live-read-only', 'read-only');
    released.resolve();
    await task.result();

    expect(executed).toEqual(['read-order']);
    expect(lastToolResult).toContain('denied');
  });

  it('holds a tool remembered for the chat to read-only, in a code agent as in a file agent', async () => {
    for (const kind of ['runner', 'helper'] as const) {
      executed.length = 0;
      const contextId = await openChat(kind, 'on-changes');
      const first = await callIn(kind, contextId, 'issue-refund');
      await approve(approvalOf(first.id).id, true);
      expect(executed).toEqual(['issue-refund']);

      commands += 1;
      await steer(contextId, `remembered-${commands}`, 'read-only');
      const denied = await callIn(kind, contextId, 'issue-refund');

      expect(reviewsOf(denied.id)).toHaveLength(0);
      expect(executed).toEqual(['issue-refund']);
    }
  });

  it('holds a call that was already waiting for approval to read-only when it is approved', async () => {
    const contextId = await openChat('runner', 'on-changes');
    const asked = await callIn('runner', contextId, 'issue-refund');
    const { id } = approvalOf(asked.id);

    await steer(contextId, 'pending-read-only', 'read-only');
    await approve(id).catch(() => undefined);

    expect(executed).toEqual([]);
  });
});

describe('asking in always (COR-1947)', () => {
  it('asks a person once, whatever else in the toolbox asks about the call', async () => {
    for (const kind of ['helper', 'coder', 'runner'] as const) {
      executed.length = 0;
      const contextId = await openChat(kind, 'always');
      const asked = await callIn(kind, contextId, 'issue-refund');
      expect(executed).toEqual([]);

      await approve(approvalOf(asked.id).id);

      expect(executed).toEqual(['issue-refund']);
      expect(reviewsOf(asked.id)).toHaveLength(0);
    }
  });

  it('puts a call to a person once for the mode and once for a toolbox’s own approval policy', async () => {
    const contextId = await openChat('guarded', 'always');
    const asked = await callIn('guarded', contextId, 'issue-refund');

    await approve(approvalOf(asked.id).id);
    expect(executed).toEqual([]);
    await approve(approvalOf(asked.id).id);

    expect(executed).toEqual(['issue-refund']);
    expect(reviewsOf(asked.id)).toHaveLength(0);
  });

  it('runs a built-in tool a person approves', async () => {
    const contextId = await openChat('coder', 'always');
    const asked = await callIn('coder', contextId, 'decide');

    const resolved = await approve(approvalOf(asked.id).id);

    expect(JSON.stringify(resolved)).toContain('"ok":true');
  });

  it('asks a code agent that does not stop on an approval', async () => {
    const contextId = await openChat('unstopped', 'always');
    const asked = await callIn('unstopped', contextId, 'issue-refund');

    expect(executed).toEqual([]);
    expect(approvalOf(asked.id).approval.toolName).toBe('issue-refund');
  });
});

describe('what the mode does not exempt (COR-1947)', () => {
  it('denies a host’s own tool in read-only under the name of Bureau’s asking tool', async () => {
    const contextId = await openChat('impostor', 'read-only');
    await callIn('impostor', contextId, 'requestHumanInput');

    expect(executed).toEqual([]);
    expect(lastToolResult).toContain('denied');
  });

  it('leaves a run that belongs to no chat to its toolbox, in a chat in read-only', async () => {
    const contextId = await openChat('coder', 'read-only');
    steps.push(() => ({ name: 'requestHumanInput', arguments: ARGUMENTS.requestHumanInput }));
    const parent = await bureau.tasks.start('coder', 'Hold.', {
      principal: OWNER.alice,
      contextId,
    });
    await waitUntil(() => reviewsOf(parent.id).length > 0, { message: 'the parent to park' });
    steps.push(() => ({ name: 'issue-refund', arguments: {} }));

    const child = await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'coder',
      input: 'go',
    });
    expect(child.outcome).toBe('started');

    await waitUntil(() => executed.length > 0, { message: 'the child’s call' });
    expect(executed).toEqual(['issue-refund']);
  });
});

describe('decideChatPermission', () => {
  it.each([
    ['read-only', 'read-only', 'allow'],
    ['read-only', 'mutating', 'deny'],
    ['read-only', 'dangerous', 'deny'],
    ['read-only', undefined, 'deny'],
    ['always', 'read-only', 'ask'],
    ['always', undefined, 'ask'],
    ['on-changes', 'mutating', 'allow'],
    ['on-changes', undefined, 'allow'],
    ['allow-all', 'mutating', 'allow'],
    ['allow-all', undefined, 'allow'],
  ] as const)('%s, a tool of tier %s: %s', (mode, tier, verdict) => {
    expect(decideChatPermission(mode, tier)).toBe(verdict);
  });
});
