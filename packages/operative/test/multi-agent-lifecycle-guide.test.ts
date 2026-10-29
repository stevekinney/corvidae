/**
 * COR-1251 — executable copies of the multi-agent lifecycle examples in
 * `documentation/multi-agent-lifecycle.md` and this package's README.
 *
 * Each test reproduces one documented example as written (only the imports
 * differ: the documentation imports from `@lostgradient/operative`, the
 * package root these tests reach through `../src/index`) and asserts every
 * result the documentation claims in a comment. The cancellation test pins
 * the cleanup contract the guide's Cancellation section states in prose.
 * Change the example and the documentation together.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  attenuateDelegationBudget,
  attenuateDelegationCapabilities,
  createAgent,
  createChildRunRegistry,
  createMockGenerate,
  createSessionHandle,
  createSessionStore,
  defineChildSignals,
  DELEGATION_GRANT_VERSION,
  dispatchChildRun,
  ForkThroughRunError,
  type GenerateFunction,
  readParentSignals,
  revokeDelegationGrant,
  signDelegationGrant,
  stopWhen,
  verifyDelegationGrant,
} from '../src/index';

describe('documentation/multi-agent-lifecycle.md — supervisor-mediated relay', () => {
  it('relays a finding from one child to its sibling through the parent, then stops only the first child', async () => {
    // One contract for both children. Only the parent holds an endpoint that
    // can address either of them.
    const teamSignals = defineChildSignals({
      signals: { hint: z.object({ text: z.string() }) },
      events: { finding: z.object({ text: z.string() }) },
    });

    // The scout reports one finding, then keeps scouting until it is stopped.
    const scout = createAgent({
      name: 'scout',
      generate: createMockGenerate([
        { content: '', toolCalls: [{ name: 'scout', arguments: {} }] },
      ]),
      tools: {
        scout: createTool({
          name: 'scout',
          description: 'Reports what it finds, then keeps looking.',
          input: z.object({}),
          async execute(_input, context) {
            const parent = readParentSignals(context.executionContext, teamSignals);
            parent?.emit('finding', { text: 'the nest is in the oak' });
            await new Promise((resolve) => {
              context.signal?.addEventListener('abort', resolve, { once: true });
            });
            return 'stopped';
          },
        }),
      },
    });

    // The builder waits for a hint from its parent and reports what it used.
    const builder = createAgent({
      name: 'builder',
      generate: async ({ step }) =>
        step === 0
          ? { content: '', toolCalls: [{ name: 'await-hint', arguments: {} }] }
          : { content: 'built from the hint', toolCalls: [] },
      tools: {
        'await-hint': createTool({
          name: 'await-hint',
          description: 'Waits for the parent to pass along a hint.',
          input: z.object({}),
          async execute(_input, context) {
            const parent = readParentSignals(context.executionContext, teamSignals);
            if (!parent) return 'no parent';
            return new Promise<string>((resolve) => {
              parent.onSignal('hint', ({ payload }) => resolve(payload.text));
            });
          },
        }),
      },
    });

    const parentRunId = crypto.randomUUID();
    const scoutRun = dispatchChildRun(scout, 'Find the nest', {
      agentName: 'scout',
      parentRunId,
      signals: teamSignals,
    });
    const builderRun = dispatchChildRun(builder, 'Build near the nest', {
      agentName: 'builder',
      parentRunId,
      signals: teamSignals,
    });

    // The parent decides what crosses between siblings.
    const relayed = new Promise((resolve) => {
      scoutRun.signals.on('finding', async ({ payload }) => {
        resolve(await builderRun.signals.send('hint', { text: payload.text }));
      });
    });

    const relayOutcome = await relayed;
    // { status: 'acknowledged', name: 'hint', parentRunId, childRunId: builderRun.childRunId, ... }
    scoutRun.abort('the builder has what it needs');

    const [scoutResult, builderResult] = await Promise.all([
      scoutRun.result(),
      builderRun.result(),
    ]);
    // scoutResult.finishReason === 'aborted'; builderResult.content === 'built from the hint'

    expect(relayOutcome).toMatchObject({
      status: 'acknowledged',
      name: 'hint',
      parentRunId,
      childRunId: builderRun.childRunId,
    });
    expect(scoutResult.finishReason).toBe('aborted');
    expect(builderResult.finishReason).toBe('stop-condition');
    expect(builderResult.content).toBe('built from the hint');
    expect(scoutRun.signals.closeReason).toBe('aborted');
    expect(builderRun.signals.closeReason).toBe('completed');
  });
});

describe('documentation/multi-agent-lifecycle.md — cancellation and cleanup', () => {
  it("settles an aborted child's result() before its cleanup, which only the registry and the parent's closed() acknowledge", async () => {
    let notifyHoldStarted: () => void = () => {};
    const holdStarted = new Promise<void>((resolve) => {
      notifyHoldStarted = resolve;
    });
    let releaseHold: () => void = () => {};
    const holdReleased = new Promise<string>((resolve) => {
      releaseHold = () => resolve('released');
    });

    // A tool callback that ignores its abort signal keeps the child's
    // cleanup pending after the child's result has settled.
    const stubborn = createAgent({
      name: 'stubborn',
      generate: createMockGenerate([{ content: '', toolCalls: [{ name: 'hold', arguments: {} }] }]),
      tools: {
        hold: createTool({
          name: 'hold',
          description: 'Ignores its abort signal until the test releases it.',
          input: z.object({}),
          async execute() {
            notifyHoldStarted();
            return holdReleased;
          },
        }),
      },
    });

    const registry = createChildRunRegistry();
    const supervisor = createAgent({
      name: 'supervisor',
      generate: createMockGenerate([{ content: 'supervised', toolCalls: [] }]),
    });
    const parentRun = supervisor.run('Supervise', { childRegistry: registry });

    const child = dispatchChildRun(stubborn, 'Hold on', {
      agentName: 'stubborn',
      parentRunId: 'supervisor-run',
      registry,
    });
    await holdStarted;
    child.abort('stop');

    // `abort()` is a request; the handle's `result()` reports the outcome.
    const childResult = await child.result();
    expect(childResult.finishReason).toBe('aborted');
    const parentResult = await parentRun.result();
    expect(parentResult.content).toBe('supervised');
    // The handle has no cleanup acknowledgement of its own.
    expect('closed' in child).toBe(false);

    let childrenClosed = false;
    const childrenClosedWait = registry.awaitChildrenClosed().then(() => {
      childrenClosed = true;
    });
    let parentClosed = false;
    const parentClosedWait = parentRun.closed().then((acknowledgement) => {
      parentClosed = true;
      return acknowledgement;
    });
    // `holdReleased` settles only through `releaseHold()`, so neither wait
    // can settle at any tick count before then.
    for (let tick = 0; tick < 25; tick++) {
      await Promise.resolve();
    }
    expect(childrenClosed).toBe(false);
    expect(parentClosed).toBe(false);

    releaseHold();

    await childrenClosedWait;
    expect(childrenClosed).toBe(true);
    expect(await parentClosedWait).toEqual({ status: 'completed' });
  });
});

describe('packages/operative/README.md — forking a session through a completed run', () => {
  it('copies only the history through the chosen run and rejects an unusable fork point', async () => {
    const generate: GenerateFunction = async ({ conversation }) => ({
      content: `reply to message ${conversation.getMessages().length}`,
      toolCalls: [],
    });

    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = createSessionHandle('support-thread', {
      store,
      agentName: 'assistant',
      // Session runs do not default `stopWhen` the way `createAgent` does.
      runOptions: { generate, toolbox: createToolbox([]), stopWhen: stopWhen.noToolCalls() },
    });

    await session.run('First question').result(); // run 0
    await session.run('Second question').result(); // run 1

    const branch = await session.fork({ throughRun: 0 });
    const forked = await branch.getSession();
    // forked.id is new, forked.runs is [], and the history holds run 0's
    // question and reply only.

    let reason: string | undefined;
    try {
      await session.fork({ throughRun: 5 });
    } catch (error) {
      if (error instanceof ForkThroughRunError) reason = error.reason; // 'out-of-range'
    }

    expect(forked.id).not.toBe('support-thread');
    expect(forked.runs).toEqual([]);
    const forkedContents = forked.conversationHistory.ids.map(
      (id) => forked.conversationHistory.messages[id]?.content,
    );
    expect(forkedContents).toContain('First question');
    expect(forkedContents).not.toContain('Second question');
    expect(forkedContents).toHaveLength(2);
    expect(reason).toBe('out-of-range');
    const source = await session.getSession();
    expect(source.runs).toHaveLength(2);
  });
});

describe('packages/operative/README.md — delegation grants', () => {
  it('signs, attenuates, and verifies a grant exactly as documented', () => {
    const secret = 'replace-with-a-real-secret';
    const now = Date.now();

    const grant = signDelegationGrant(
      {
        version: DELEGATION_GRANT_VERSION,
        id: 'delegation:planner-1',
        parentRunId: 'root-run',
        childRunId: 'planner-1',
        agentName: 'planner',
        agentVersion: '1',
        objective: 'Plan the corvid report',
        recipientId: 'planner-1',
        effectiveCapabilities: { tools: ['search', 'fetch'], network: ['example.com'] },
        delegatedAuthority: { policyVersion: 'policy/1' },
        budget: { concurrentChildren: 2, totalDescendants: 4 },
        depth: 1,
        policyVersion: 'policy/1',
        issuedAt: now,
        expiresAt: now + 60_000,
        revoked: false,
        disclosurePolicy: 'redacted',
      },
      secret,
    );

    const capabilities = attenuateDelegationCapabilities(grant.effectiveCapabilities, {
      tools: ['search', 'shell'],
      network: true,
    });
    // { tools: ['search'], network: ['example.com'] }

    const budget = attenuateDelegationBudget(grant.budget, { concurrentChildren: 5, steps: 20 });
    // { concurrentChildren: 2, totalDescendants: 4, steps: 20 }

    const valid = verifyDelegationGrant(grant, secret, now); // { valid: true }
    const tampered = verifyDelegationGrant({ ...grant, depth: 5 }, secret, now); // code: 'invalid-signature'
    const revoked = verifyDelegationGrant(revokeDelegationGrant(grant, secret), secret, now); // code: 'revoked'
    const expired = verifyDelegationGrant(grant, secret, grant.expiresAt); // code: 'expired'

    expect(capabilities).toEqual({ tools: ['search'], network: ['example.com'] });
    expect(budget).toEqual({ concurrentChildren: 2, totalDescendants: 4, steps: 20 });
    expect(valid).toEqual({ valid: true });
    expect(tampered).toMatchObject({ valid: false, code: 'invalid-signature' });
    expect(revoked).toMatchObject({ valid: false, code: 'revoked' });
    expect(expired).toMatchObject({ valid: false, code: 'expired' });
  });
});
