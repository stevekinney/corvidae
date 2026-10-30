/**
 * COR-1913 — a file agent's `toolApproval` on real runs: what each value does to a read-only and a
 * mutating tool, that a call which asks parks the run on a signed approval, that the approval
 * survives a restart and resumes, and that two concurrent runs of one agent decide separately.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { BureauError } from './create-bureau';
import { agentFileDirectory } from './sources/agent-file-directory';
import { waitForCondition } from './test';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import {
  type FileBureauHarness,
  type FileBureauOptions,
  startFileBureau,
} from './testing/agent-file-bureau.test-support';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import type { Bureau } from './types';

const executed: string[] = [];

const lookupOrder = createTool({
  name: 'lookup-order',
  version: '1.0.0',
  description: 'Look an order up',
  input: z.object({ orderId: z.string() }),
  metadata: { readOnly: true },
  execute: async ({ orderId }) => {
    executed.push(`lookup-order:${orderId}`);
    return { orderId, status: 'delivered' };
  },
});

const issueRefund = createTool({
  name: 'issue-refund',
  version: '1.0.0',
  description: 'Refund an order',
  input: z.object({ orderId: z.string() }),
  metadata: { mutates: true, summary: 'Refund order {orderId}' },
  execute: async ({ orderId }) => {
    executed.push(`issue-refund:${orderId}`);
    return { refunded: orderId };
  },
});

const TOOLS = { 'lookup-order': lookupOrder, 'issue-refund': issueRefund };
const ALICE = 'api-key:alice';
const BOB = 'api-key:bob';

const roots: string[] = [];
const harnesses: FileBureauHarness[] = [];
const fixtures: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  executed.length = 0;
});

interface Plan {
  /** The tool the model asks for on its first step, and the order it asks about. */
  tool: string;
  orderId: string;
}

interface StartOptions {
  /** The secret that signs the approvals; none leaves them unsigned. */
  readonly secret?: string | undefined;
  /** Reuse an agent directory: a restart over the same files. */
  readonly directory?: string;
  /** What the model asks for on its first step of a run, read when the step runs. */
  readonly plan: { current: Plan };
  readonly overrides?: FileBureauOptions['overrides'];
}

/** Runs a file Bureau whose model asks for `plan.tool` once per order, then answers. */
async function start(options: StartOptions): Promise<FileBureauHarness & { directory: string }> {
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), 'bureau-tool-approval-')));
  if (options.directory === undefined) roots.push(directory);
  const asked = new Set<string>();
  const harness = await startFileBureau({
    directory,
    scripts: {
      [KNOWN_MODEL.split('/')[1] as string]: () => {
        // A run asks once. Its second step, after the tool's result or its refusal, answers.
        const key = `${options.plan.current.tool}:${options.plan.current.orderId}`;
        if (asked.has(key)) return 'Done.';
        asked.add(key);
        return {
          content: '',
          toolCalls: [
            {
              name: options.plan.current.tool,
              arguments: { orderId: options.plan.current.orderId },
            },
          ],
        };
      },
    },
    overrides: {
      ...(options.secret === undefined ? {} : { agentApprovalSecret: options.secret }),
      agentSource: agentFileDirectory(directory, { tools: TOOLS }),
      ...options.overrides,
    },
  });
  harnesses.push(harness);
  return Object.assign(harness, { directory });
}

function pendingOf(bureau: Bureau, runId: string) {
  return bureau.reviews.list().filter((review) => review.runId === runId);
}

describe('toolApproval on a file agent’s runs', () => {
  type Outcome = 'ran' | 'asked' | 'denied';
  const CASES: ReadonlyArray<{
    readonly value: string | undefined;
    readonly tool: 'lookup-order' | 'issue-refund';
    readonly outcome: Outcome;
  }> = [
    { value: undefined, tool: 'lookup-order', outcome: 'ran' },
    { value: undefined, tool: 'issue-refund', outcome: 'asked' },
    { value: 'never', tool: 'lookup-order', outcome: 'ran' },
    { value: 'never', tool: 'issue-refund', outcome: 'ran' },
    { value: 'on-changes', tool: 'lookup-order', outcome: 'ran' },
    { value: 'on-changes', tool: 'issue-refund', outcome: 'asked' },
    { value: 'always', tool: 'lookup-order', outcome: 'asked' },
    { value: 'always', tool: 'issue-refund', outcome: 'asked' },
    { value: 'blocked', tool: 'lookup-order', outcome: 'denied' },
    { value: 'blocked', tool: 'issue-refund', outcome: 'denied' },
  ];

  it.each(CASES)('with $value on $tool, the call is $outcome', async ({ value, tool, outcome }) => {
    const plan = { current: { tool, orderId: 'A1' } };
    const harness = await start({ plan, secret: 'file-agent-secret' });
    await harness.put(
      'helper.md',
      agentFileText({
        model: KNOWN_MODEL,
        tools: '[lookup-order, issue-refund]',
        ...(value === undefined ? {} : { toolApproval: `{ ${tool}: ${value} }` }),
      }),
    );
    await harness.bureau.agents.refresh();

    const task = await harness.bureau.tasks.start('helper', 'Go.', { principal: ALICE });
    const result = await task.result();

    if (outcome === 'ran') {
      expect(executed).toEqual([`${tool}:A1`]);
      expect(pendingOf(harness.bureau, task.id)).toHaveLength(0);
      expect(result.content).toBe('Done.');
    } else if (outcome === 'asked') {
      // The tool did not run, and the run stopped on the approval without asking the model again.
      expect(executed).toEqual([]);
      const [review] = pendingOf(harness.bureau, task.id);
      expect(review).toMatchObject({ kind: 'tool-approval', agentName: 'helper' });
      expect(review?.kind === 'tool-approval' && review.approval.toolName).toBe(tool);
      expect(result.content).toBe('');
    } else {
      // Denied: the model is told, the review queue holds nothing, and the run goes on.
      expect(executed).toEqual([]);
      expect(pendingOf(harness.bureau, task.id)).toHaveLength(0);
      expect(result.content).toBe('Done.');
    }
  });

  it('raises an approval a person can approve, which then runs the tool once', async () => {
    const plan = { current: { tool: 'issue-refund' as const, orderId: 'A1' } };
    const harness = await start({ plan, secret: 'file-agent-secret' });
    await harness.put('helper.md', agentFileText({ model: KNOWN_MODEL, tools: '[issue-refund]' }));
    await harness.bureau.agents.refresh();
    const task = await harness.bureau.tasks.start('helper', 'Go.', { principal: ALICE });
    await task.result();
    const [review] = pendingOf(harness.bureau, task.id);
    if (review?.kind !== 'tool-approval') throw new Error('Expected a tool approval.');
    expect(review.approval.approvalToken).toBeDefined();
    // The approval says what the call does, in the tool’s own words.
    expect(review.approval.action?.message).toBe('Refund order A1');

    const resolved = await harness.bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: BOB,
    });

    expect(resolved).toMatchObject({ kind: 'tool-approval', decision: 'approve' });
    expect(executed).toEqual(['issue-refund:A1']);
    expect(pendingOf(harness.bureau, task.id)).toHaveLength(0);
  });

  it('can only deny an approval when the Bureau has no agentApprovalSecret', async () => {
    const plan = { current: { tool: 'issue-refund' as const, orderId: 'A1' } };
    const harness = await start({ plan });
    await harness.put('helper.md', agentFileText({ model: KNOWN_MODEL, tools: '[issue-refund]' }));
    await harness.bureau.agents.refresh();
    const task = await harness.bureau.tasks.start('helper', 'Go.', { principal: ALICE });
    await task.result();
    const [review] = pendingOf(harness.bureau, task.id);
    if (review?.kind !== 'tool-approval') throw new Error('Expected a tool approval.');
    expect(review.approval.approvalToken).toBeUndefined();

    const refused = await harness.bureau.reviews
      .resolve({ id: review.id, decision: 'approve', principal: BOB })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(BureauError);
    expect((refused as BureauError).code).toBe('NOT_CONFIGURED');
    expect(executed).toEqual([]);

    await harness.bureau.reviews.resolve({
      id: review.id,
      decision: 'deny',
      principal: BOB,
    });
    expect(pendingOf(harness.bureau, task.id)).toHaveLength(0);
    expect(executed).toEqual([]);
  });

  it('refuses an empty agentApprovalSecret at createBureau', async () => {
    const plan = { current: { tool: 'issue-refund' as const, orderId: 'A1' } };

    const refused = await start({ plan, secret: '  ' }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(BureauError);
    expect((refused as BureauError).code).toBe('BAD_REQUEST');
    expect((refused as BureauError).message).toContain('agentApprovalSecret');
  });

  it('keeps a pending approval across a restart, and resumes it once approved', async () => {
    const database = createSqliteStorageFixture();
    fixtures.push(database);
    const plan = { current: { tool: 'issue-refund' as const, orderId: 'R1' } };
    const first = await start({
      plan,
      secret: 'stable-secret',
      overrides: { storage: database.storage },
    });
    await first.put('helper.md', agentFileText({ model: KNOWN_MODEL, tools: '[issue-refund]' }));
    await first.bureau.agents.refresh();
    const task = await first.bureau.tasks.start('helper', 'Go.', { principal: ALICE });
    await task.result();
    const [before] = pendingOf(first.bureau, task.id);
    expect(before?.kind).toBe('tool-approval');
    await first.dispose();
    harnesses.splice(harnesses.indexOf(first), 1);

    const second = await start({
      plan,
      secret: 'stable-secret',
      directory: first.directory,
      overrides: { storage: await database.reopen() },
    });
    await waitForCondition(
      () => pendingOf(second.bureau, task.id).length === 1,
      'the pending approval was not restored after the restart',
    );
    const [restored] = pendingOf(second.bureau, task.id);
    expect(restored?.id).toBe(before?.id);
    expect(executed).toEqual([]);

    await second.bureau.reviews.resolve({
      id: restored!.id,
      decision: 'approve',
      principal: BOB,
    });

    expect(executed).toEqual(['issue-refund:R1']);
    expect(pendingOf(second.bureau, task.id)).toHaveLength(0);
  });

  it('decides two concurrent runs of one agent separately', async () => {
    const plan = { current: { tool: 'issue-refund' as const, orderId: 'A1' } };
    const harness = await start({ plan, secret: 'file-agent-secret' });
    await harness.put(
      'helper.md',
      agentFileText({ model: KNOWN_MODEL, tools: '[lookup-order, issue-refund]' }),
    );
    await harness.bureau.agents.refresh();
    // Both runs are parked on an approval at once, each on a toolbox of its own.
    const first = await harness.bureau.tasks.start('helper', 'First.', { principal: ALICE });
    await first.result();
    plan.current = { tool: 'issue-refund', orderId: 'B2' };
    const second = await harness.bureau.tasks.start('helper', 'Second.', { principal: ALICE });
    await second.result();
    const [firstReview] = pendingOf(harness.bureau, first.id);
    const [secondReview] = pendingOf(harness.bureau, second.id);
    if (firstReview === undefined || secondReview === undefined) {
      throw new Error('Expected each run to hold its own approval.');
    }
    expect(firstReview.id).not.toBe(secondReview.id);

    await harness.bureau.reviews.resolve({
      id: secondReview.id,
      decision: 'approve',
      principal: BOB,
    });
    await harness.bureau.reviews.resolve({ id: firstReview.id, decision: 'deny', principal: BOB });

    expect(executed).toEqual(['issue-refund:B2']);
  });
});
