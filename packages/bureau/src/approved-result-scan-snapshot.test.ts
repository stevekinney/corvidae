/**
 * COR-2387 — after a restart, an approved call's result is scanned with the guardrails of the
 * definition its run recorded (COR-1524), not the ones the catalog holds now: an operator's edit
 * made while the run was parked must not change what scans it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GUARDRAIL_BLOCKED_CODE, readSessionTaint } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createAgentContributions } from './agent-contributions';
import { agentFileDirectory } from './sources/agent-file-directory';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';

const issueRefund = createTool({
  name: 'issue-refund',
  version: '1.0.0',
  description: 'Refund an order',
  input: z.object({ orderId: z.string() }),
  metadata: { mutates: true },
  execute: async ({ orderId }) => ({ refunded: orderId }),
});

const contributions = createAgentContributions([
  {
    plugin: 'x',
    guardrails: {
      input: [
        {
          name: 'check',
          description: 'Flags the sentinel.',
          detect: async (input) =>
            input.includes('SENTINEL')
              ? { triggered: true, category: 'policy', confidence: 0.99, detail: 'sentinel' }
              : { triggered: false, category: 'policy', confidence: 0 },
        },
      ],
    },
  },
]);

const harnesses: FileBureauHarness[] = [];
let directory: string | undefined;

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function open(storage: MemoryStorage, root: string): Promise<FileBureauHarness> {
  let asked = false;
  const harness = await startFileBureau({
    directory: root,
    scripts: {
      [KNOWN_MODEL.split('/')[1] as string]: () => {
        if (asked) return 'Done.';
        asked = true;
        return {
          content: '',
          toolCalls: [{ name: 'issue-refund', arguments: { orderId: 'SENTINEL' } }],
        };
      },
    },
    overrides: {
      storage,
      agentApprovalSecret: 'approved-scan-snapshot-secret',
      agentContributions: contributions,
      agentSource: agentFileDirectory(root, { tools: { 'issue-refund': issueRefund } }),
    },
  });
  harnesses.push(harness);
  return harness;
}

describe('an approved call scanned after a restart (COR-2387)', () => {
  it('uses the guardrails the run recorded, not the ones the agent file holds now', async () => {
    directory = await mkdtemp(join(tmpdir(), 'bureau-approved-scan-snapshot-'));
    const storage = new MemoryStorage();

    const first = await open(storage, directory);
    await first.put(
      'helper.md',
      agentFileText({ model: KNOWN_MODEL, tools: '[issue-refund]', guardrails: '[x:check]' }),
    );
    await first.bureau.agents.refresh();
    const task = await first.bureau.tasks.start('helper', 'Refund it.');
    await task.result();
    const [parked] = first.bureau.reviews.list();
    if (parked?.kind !== 'tool-approval') throw new Error('Expected the refund to park.');
    await first.dispose();
    harnesses.splice(0);

    // The operator edits the agent while the run is parked: the guardrail is gone from the file.
    const second = await open(storage, directory);
    await second.put('helper.md', agentFileText({ model: KNOWN_MODEL, tools: '[issue-refund]' }));
    await second.bureau.agents.refresh();
    const [review] = second.bureau.reviews.list();
    if (review?.kind !== 'tool-approval') throw new Error('Expected the approval to be restored.');
    await second.bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'operator',
    });

    const session = await second.bureau.internals.sessionStore?.load(review.sessionId);
    const history = session?.conversationHistory;
    const row = history?.ids
      .map((id) => history.messages[id])
      .find((message) => message?.toolResult !== undefined)?.toolResult;
    expect(row).toMatchObject({ outcome: 'error', error: { code: GUARDRAIL_BLOCKED_CODE } });
    expect(readSessionTaint(session?.metadata)).toMatchObject({ detector: 'check' });
  });
});
