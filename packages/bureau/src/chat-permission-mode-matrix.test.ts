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

import {
  createAgent,
  createSubagentTool,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import {
  createProcessLocalGrantStateStore,
  createTool,
  createToolbox,
  type ToolRequestContext,
} from 'armorer';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { BureauError } from './create-bureau';
import { createBureauHandler } from './http/create-bureau-handler';
import { authentication, OWNER, rpc } from './http/management/management-fixtures.test-support';
import { agentFileDirectory } from './sources/agent-file-directory';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { createToolApprovalHooks, decideChatPermission } from './tool-approval';
import { ToolClashError } from './toolbox-additions';
import type { Bureau, BureauDiagnostic } from './types';

const SECRET = 'permission-mode-matrix-secret';
const executed: string[] = [];
/** What Bureau reported about itself, so a report a row expects is not printed as an error. */
const diagnostics: BureauDiagnostic[] = [];

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

/** Where a code agent's toolbox keeps its reusable grants, and the authority its runs carry. */
const grants = createProcessLocalGrantStateStore();
let grantedAuthority: ToolRequestContext | undefined;
const grantedToolbox = createToolbox(OWN_TOOLS, {
  approvalSecret: SECRET,
  approvalPolicy: { mode: 'on-mutation' },
  grantStateStore: grants,
  policy: {
    beforeExecute(context) {
      grantedAuthority = context.policyContext?.['requestContext'] as ToolRequestContext;
    },
  },
});

/**
 * A child a code agent starts with `createSubagentTool`: the tool calls the child's `run()` itself,
 * so Bureau never sees the child, its toolbox is the one the host built, and no mode reaches it.
 */
const rawChild = createAgent({
  name: 'raw-child',
  generate,
  toolbox: createToolbox(OWN_TOOLS, { approvalSecret: SECRET }),
});
const delegateToRawChild = createSubagentTool({
  name: 'delegate',
  description: 'Hands the work to a child.',
  agent: rawChild,
  agentName: 'raw-child',
  input: z.object({}),
});

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
  // A toolbox a reusable grant can answer an `approvalPolicy` ask of.
  granted: createAgent({
    name: 'granted',
    generate,
    toolbox: grantedToolbox,
    stopWhen: parksOnApproval,
  }),
  // A code agent whose child is a raw `createSubagentTool` one.
  delegator: createAgent({
    name: 'delegator',
    generate,
    toolbox: createToolbox([delegateToRawChild], { approvalSecret: SECRET }),
    stopWhen: parksOnApproval,
  }),
  // A code agent that does not stop on an approval.
  unstopped: createAgent({
    name: 'unstopped',
    generate,
    toolbox: createToolbox(OWN_TOOLS, { approvalSecret: SECRET }),
  }),
  // A host's own tool under the name of Bureau's asking tool, which changes something and declares
  // in its metadata what a remote server could write there.
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
          metadata: { mutates: true, onlyAsksAPerson: true },
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
 * denies it. It parks the step that calls it, and an approved call runs after that step, so it
 * cannot be asked about and `always` denies it as well. `decide` asks a model a question and
 * changes nothing, so it is a read, and it asks in `always` like any tool. In `on-changes` the tool's own setting decides, and a code agent whose
 * toolbox says nothing lets a change through, as it always has.
 */
const TABLE: Readonly<Record<(typeof KINDS)[number], Readonly<Record<Mode, Row>>>> = {
  helper: {
    'on-changes': ['runs', 'asks', 'runs', 'runs', 'runs'],
    always: ['asks', 'asks', 'runs', 'denied', 'asks'],
    'allow-all': ['runs', 'runs', 'runs', 'runs', 'runs'],
    'read-only': ['runs', 'denied', 'runs', 'denied', 'runs'],
  },
  coder: {
    'on-changes': ['runs', 'runs', 'runs', 'runs', 'runs'],
    always: ['asks', 'asks', 'runs', 'denied', 'asks'],
    'allow-all': ['runs', 'runs', 'runs', 'runs', 'runs'],
    'read-only': ['runs', 'denied', 'runs', 'denied', 'runs'],
  },
  runner: {
    'on-changes': ['runs', 'asks', 'runs', 'runs', 'runs'],
    always: ['asks', 'asks', 'runs', 'denied', 'asks'],
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
      onDiagnostic: (diagnostic) => void diagnostics.push(diagnostic),
      // COR-1955: a task is kept for no time once it ends, so `maintain()` removes its records.
      retention: { tasks: { olderThan: 0 } },
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
  diagnostics.length = 0;
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
    const refused = await approve(id).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(BureauError);
    expect(String(refused)).toContain('read-only mode');
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

  it('denies a wakeup, which no approval could run, and tells the model why', async () => {
    const contextId = await openChat('coder', 'always');
    const denied = await callIn('coder', contextId, 'scheduleWakeup');

    expect(reviewsOf(denied.id)).toHaveLength(0);
    expect(lastToolResult).toContain('an approval could not run it');
  });

  it('asks a code agent that does not stop on an approval', async () => {
    const contextId = await openChat('unstopped', 'always');
    const asked = await callIn('unstopped', contextId, 'issue-refund');

    expect(executed).toEqual([]);
    expect(approvalOf(asked.id).approval.toolName).toBe('issue-refund');
  });
});

describe('a reusable grant (COR-1947)', () => {
  /** A grant for the refund, issued to the authority `granted`'s runs carry. */
  async function issueGrant(): Promise<string> {
    const probe = await openChat('granted', 'on-changes');
    await callIn('granted', probe, 'read-order');
    executed.length = 0;
    if (grantedAuthority === undefined) throw new Error('Expected a run to carry an authority.');
    const { authority, agentId } = grantedAuthority;
    const grant = await grantedToolbox.issueGrant({
      principalId: authority.principalId,
      tenantId: authority.tenantId,
      ownerId: authority.ownerId,
      agentId: agentId ?? 'granted',
      toolName: 'issue-refund',
      scope: 'principal',
      expiresAt: Number.MAX_SAFE_INTEGER,
      maxUses: 5,
      delegationBehavior: 'does-not-propagate',
    });
    return grant.id;
  }

  const usesLeft = async (id: string) => {
    const grant = await grants.get(id);
    return grant?.usesRemaining;
  };

  it('answers the ask of a chat the mode leaves to the toolbox', async () => {
    const id = await issueGrant();
    const contextId = await openChat('granted', 'on-changes');

    const task = await callIn('granted', contextId, 'issue-refund');

    expect(reviewsOf(task.id)).toHaveLength(0);
    expect(executed).toEqual(['issue-refund']);
    expect(await usesLeft(id)).toBe(4);
  });

  it('does not run a call a chat in read-only denies, and is not spent on it', async () => {
    const id = await issueGrant();
    const contextId = await openChat('granted', 'read-only');

    const task = await callIn('granted', contextId, 'issue-refund');

    expect(reviewsOf(task.id)).toHaveLength(0);
    expect(lastToolResult).toContain('denied');
    expect(executed).toEqual([]);
    expect(await usesLeft(id)).toBe(5);
  });

  it('does not answer the ask of a chat in always, and is not spent on it', async () => {
    const id = await issueGrant();
    const contextId = await openChat('granted', 'always');

    const task = await callIn('granted', contextId, 'issue-refund');

    expect(approvalOf(task.id).approval.toolName).toBe('issue-refund');
    expect(executed).toEqual([]);
    expect(await usesLeft(id)).toBe(5);
  });
});

describe('what the mode does not exempt (COR-1947)', () => {
  // COR-1875: a host tool under the name of Bureau's asking tool used to shadow it silently, and the
  // mode was what still denied it. Adding Bureau's tool to a toolbox that has the name now throws,
  // so the lookalike never reaches a chat, in any mode, and its tool never runs.
  it('refuses a run whose host tool has the name of Bureau’s asking tool', async () => {
    let refusal: unknown;
    try {
      await bureau.tasks.start('impostor', 'Hello.', { principal: OWNER.alice });
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(ToolClashError);
    expect((refusal as ToolClashError).addedId).toBe('default:requestHumanInput');
    expect((refusal as ToolClashError).existingIds).toEqual(['default:requestHumanInput@1.0.0']);
    expect(executed).toEqual([]);
  });
});

/** The children of the COR-1955 rows, which every row names so a run is found by its own id. */
let childCount = 0;
const nextChildId = () => `matrix-child-${(childCount += 1)}`;

/**
 * A chat in `on-changes` with one live run parked on a question, the root of a delegation chain. The
 * run is parked, not finished, so it can own children.
 */
async function parkedParent(kind: 'coder' | 'helper' = 'coder') {
  const contextId = await openChat(kind, 'on-changes');
  steps.push(() => ({ name: 'requestHumanInput', arguments: ARGUMENTS.requestHumanInput }));
  const parent = await bureau.tasks.start(kind, 'Hold.', { principal: OWNER.alice, contextId });
  await waitUntil(() => reviewsOf(parent.id).length > 0, { message: 'the parent to park' });
  return { parent, contextId };
}

/**
 * A chat in `on-changes` with one live run whose model is held at its first step, the root of a
 * chain whose parent can then complete (`finish`), as a parked one cannot.
 */
async function finishingParent() {
  const contextId = await openChat('coder', 'on-changes');
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  steps.push(async () => {
    entered.resolve();
    await released.promise;
    return { name: 'read-order', arguments: {} };
  });
  const parent = await bureau.tasks.start('coder', 'Hold.', { principal: OWNER.alice, contextId });
  await entered.promise;
  /** Lets the parent's step go, and waits until the parent has completed. */
  const finish = async () => {
    released.resolve();
    await parent.result();
  };
  return { parent, contextId, finish };
}

/**
 * A child dispatched under `parentRunId` whose model is held at its first step, then calls `tool`
 * once the returned `release` is called. The child is running, with its call undecided, until then.
 */
async function gatedChild(
  parentRunId: string,
  tool: ToolName,
  options: { readonly detach?: boolean; readonly agentName?: string } = {},
) {
  const childRunId = nextChildId();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  steps.push(async () => {
    entered.resolve();
    await released.promise;
    return { name: tool, arguments: ARGUMENTS[tool] };
  });
  const dispatched = await bureau.children.dispatch({
    parentRunId,
    agentName: options.agentName ?? 'coder',
    input: 'go',
    childRunId,
    ...(options.detach === true ? { parentCancellation: 'detach' as const } : {}),
  });
  expect(dispatched.outcome).toBe('started');
  await entered.promise;
  return { parentRunId, childRunId, release: () => released.resolve() };
}

/**
 * Whether the child's one call ran, once the child has ended. A child has no chat to put a question to, so a call its chat's
 * mode would ask about is refused for want of anyone to approve it: in `always`, a child runs
 * nothing. Both that and a `read-only` denial are `held`, and neither runs the tool.
 */
async function childOutcome(
  child: { readonly parentRunId: string; readonly childRunId: string },
  tool: ToolName,
): Promise<'runs' | 'held'> {
  // The child has ended once its call is decided and the model has been shown the result.
  const waited = await bureau.children.wait(child);
  expect(waited.outcome).toBe('settled');
  return executed.includes(tool) ? 'runs' : 'held';
}

/** What a child of the code agent does in `mode` for a tool: `runs`, or is `held` and runs nothing. */
const childExpectation = (mode: Mode, tool: 'read-order' | 'issue-refund') =>
  TABLE.coder[mode][TOOLS.indexOf(tool)] === 'runs' ? 'runs' : 'held';

describe('a child run already running when its chat is steered (COR-1955)', () => {
  for (const mode of MODES) {
    for (const tool of ['read-order', 'issue-refund'] as const) {
      const expected = childExpectation(mode, tool);
      it(`takes ${mode} at its next call: ${tool} ${expected}`, async () => {
        const { parent, contextId } = await parkedParent();
        const child = await gatedChild(parent.id, tool);

        commands += 1;
        await steer(contextId, `child-steer-${commands}`, mode);
        child.release();

        expect(await childOutcome(child, tool)).toBe(expected);
        expect(executed).toEqual(expected === 'runs' ? [tool] : []);
        // A child has no one to ask, so `always` names the mode instead of parking on an approval.
        if (mode === 'always') expect(lastToolResult).toContain('is in always mode');
        parent.abort();
      });
    }
  }

  it('holds a file agent child to the mode as well', async () => {
    const { parent, contextId } = await parkedParent();
    const child = await gatedChild(parent.id, 'issue-refund', { agentName: 'helper' });

    commands += 1;
    await steer(contextId, `child-file-${commands}`, 'read-only');
    child.release();

    expect(await childOutcome(child, 'issue-refund')).toBe('held');
    expect(executed).toEqual([]);
    parent.abort();
  });

  it('holds a grandchild to the mode of the chat at the root', async () => {
    const { parent, contextId } = await parkedParent();
    // A child cannot park on a question, so the middle of the chain is held at its first step.
    const middle = await gatedChild(parent.id, 'read-order');
    const grandchild = await gatedChild(middle.childRunId, 'issue-refund');

    commands += 1;
    await steer(contextId, `grandchild-${commands}`, 'read-only');
    grandchild.release();

    expect(await childOutcome(grandchild, 'issue-refund')).toBe('held');
    expect(executed).toEqual([]);
    middle.release();
    parent.abort();
  });

  it('holds a detached child whose parent has ended', async () => {
    const { parent, contextId } = await parkedParent();
    const child = await gatedChild(parent.id, 'issue-refund', { detach: true });
    parent.abort();
    await parent.result().catch(() => undefined);

    commands += 1;
    await steer(contextId, `detached-${commands}`, 'read-only');
    child.release();

    expect(await childOutcome(child, 'issue-refund')).toBe('held');
    expect(executed).toEqual([]);
  });

  it('holds a cascade child whose parent has completed', async () => {
    const { parent, contextId, finish } = await finishingParent();
    const child = await gatedChild(parent.id, 'issue-refund');
    await finish();

    commands += 1;
    await steer(contextId, `completed-${commands}`, 'read-only');
    child.release();

    expect(await childOutcome(child, 'issue-refund')).toBe('held');
    expect(executed).toEqual(['read-order']);
  });

  it('holds a detached child whose parent’s task and run records have expired', async () => {
    const { parent, contextId, finish } = await finishingParent();
    const child = await gatedChild(parent.id, 'issue-refund', { detach: true });
    await finish();
    await bureau.maintain();
    // The records a mode used to be found by are gone, which is what this row is about.
    expect(await bureau.tasks.get(parent.id)).toBeUndefined();

    commands += 1;
    await steer(contextId, `expired-${commands}`, 'read-only');
    child.release();

    expect(await childOutcome(child, 'issue-refund')).toBe('held');
    expect(lastToolResult).toContain('denied');
    expect(executed).toEqual(['read-order']);
  });

  it('holds a grandchild whose parent and grandparent have expired', async () => {
    const { parent, contextId, finish } = await finishingParent();
    const middle = await gatedChild(parent.id, 'read-order', { detach: true });
    const grandchild = await gatedChild(middle.childRunId, 'issue-refund', { detach: true });
    await finish();
    middle.release();
    await bureau.maintain();

    commands += 1;
    await steer(contextId, `grand-expired-${commands}`, 'read-only');
    grandchild.release();
    expect(await childOutcome(grandchild, 'issue-refund')).toBe('held');
    expect(executed).not.toContain('issue-refund');
  });

  it('holds a detached child to read-only, naming the chat, once the chat is deleted', async () => {
    const { parent, contextId, finish } = await finishingParent();
    const child = await gatedChild(parent.id, 'issue-refund', { detach: true });
    await finish();
    await bureau.contexts.delete(contextId);

    child.release();

    expect(await childOutcome(child, 'issue-refund')).toBe('held');
    expect(JSON.parse(lastToolResult ?? '""')).toContain(
      `the chat "${contextId}" this child run belongs to was deleted`,
    );
    // The unreadable mode is reported, not only acted on.
    expect(diagnostics.some((entry) => entry.scope === 'permission-mode')).toBe(true);
    expect(executed).toEqual(['read-order']);
  });

  it('does not let allow-all loosen a file agent child’s own on-changes ask', async () => {
    const { parent, contextId } = await parkedParent();
    const child = await gatedChild(parent.id, 'issue-refund', { agentName: 'helper' });

    commands += 1;
    await steer(contextId, `child-allow-all-${commands}`, 'allow-all');
    child.release();

    expect(await childOutcome(child, 'issue-refund')).toBe('held');
    expect(executed).toEqual([]);
    parent.abort();
  });

  it('holds a child started after the chat was steered', async () => {
    const { parent, contextId } = await parkedParent();
    commands += 1;
    await steer(contextId, `before-child-${commands}`, 'read-only');

    const child = await gatedChild(parent.id, 'issue-refund');
    child.release();

    expect(await childOutcome(child, 'issue-refund')).toBe('held');
    expect(executed).toEqual([]);
    parent.abort();
  });
});

describe('a child Bureau does not start (COR-1955)', () => {
  it('is not held by a mode: a raw createSubagentTool child runs its calls as its toolbox says', async () => {
    const contextId = await openChat('delegator', 'on-changes');
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    steps.push(
      () => ({ name: 'delegate', arguments: {} }),
      async () => {
        entered.resolve();
        await released.promise;
        return { name: 'issue-refund', arguments: {} };
      },
    );
    const task = await bureau.tasks.start('delegator', 'Go.', {
      principal: OWNER.alice,
      contextId,
    });
    await entered.promise;

    commands += 1;
    await steer(contextId, `raw-child-${commands}`, 'read-only');
    released.resolve();
    await task.result();

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

  it('denies a tool that cannot wait for an approval where always would ask', () => {
    expect(decideChatPermission('always', 'mutating', 'cannot-wait-for-approval')).toBe('deny');
    expect(decideChatPermission('allow-all', 'mutating', 'cannot-wait-for-approval')).toBe('allow');
  });
});
