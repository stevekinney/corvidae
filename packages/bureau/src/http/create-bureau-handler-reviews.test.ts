/**
 * COR-1849 — the handler's reviews adapter passes `listResolved` through, so
 * `bureau.reviews.list` with `status: 'resolved'` lists a decision a person made. It once dropped
 * the member, and the list fell back to empty on a real host.
 */
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { principalFromApiKey } from '@lostgradient/weft';
import { createToolbox, type Tool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../agent-catalog';
import { createMemoryAssetStorage } from '../assets/storage';
import { createBureau } from '../create-bureau.ts';
import { waitForCondition } from '../test';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import { createBureauHandler } from './create-bureau-handler.ts';

const API_KEY = 'reviews-handler-key';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const generate: GenerateFunction = async (context) =>
  context.step === 0
    ? {
        content: '',
        toolCalls: [
          {
            id: 'call-1',
            name: 'requestHumanInput',
            arguments: { signalName: 'answer', prompt: 'Which environment?' },
          },
        ],
      }
    : { content: 'thanks', toolCalls: [] };

function rpc(method: string, params: unknown) {
  return new Request('http://localhost/jsonrpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

type Listed = { result?: { reviews: Array<{ id: string; status: string }> } };

async function listResolved(handler: (request: Request) => Promise<Response>): Promise<Listed> {
  const response = await handler(rpc('bureau.reviews.list', { status: 'resolved' }));
  return (await response.json()) as Listed;
}

describe('createBureauHandler reviews (COR-1849)', () => {
  it('lists a decided review as resolved through the served operation', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      id: 'handler-reviews-bureau',
      assets: { storage: createMemoryAssetStorage() },
      agents: {
        asker: createAgent({
          generate,
          toolbox: createToolbox<readonly Tool[]>([]),
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
    });
    disposers.push(() => bureau.dispose());
    const handler = createBureauHandler(bureau, {
      authentication: {
        auditSink: () => undefined,
        resolveApiKeyPrincipal: async (key) =>
          key === API_KEY
            ? principalFromApiKey({ subject: 'alice', scopes: ['events:read', ...BUREAU_SCOPES] })
            : null,
      },
    });
    const run = await bureau.tasks.start('asker', 'deploy', { principal: 'api-key:alice' });
    await waitForCondition(
      () => bureau.reviews.list().some((review) => review.runId === run.id),
      'expected requestHumanInput to park and surface a review',
    );
    const review = bureau.reviews.list().find((candidate) => candidate.runId === run.id);
    if (review === undefined) throw new Error('Expected a review.');

    const before = await listResolved(handler);
    expect(before.result?.reviews).toEqual([]);

    await bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'api-key:alice',
      payload: { environment: 'production' },
    });

    const after = await listResolved(handler);
    expect(after.result?.reviews.map((entry) => entry.id)).toEqual([review.id]);
    expect(after.result?.reviews[0]?.status).toBe('approved');
  });
});
