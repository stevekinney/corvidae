/**
 * COR-792 — tool-result media through Bureau: an image a tool returns is admitted as a managed
 * asset owned by the run's principal before the conversation, an event, or an audit record keeps
 * it; the model then reads it through the run's resolver, and no other principal can.
 */
import {
  createAgent,
  createModelCatalog,
  type GenerateContext,
  type GenerateResponse,
  stopWhen,
  type Toolbox,
  waitForRunState,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { toolContent } from 'armorer/protocol';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import { alice, base64Of, bob, pngBytes } from './testing/asset-fixtures.test-support';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  await yieldToPortableEventLoop();
});

const snapshotPng = pngBytes(5, 4);
const snapshotBase64 = base64Of(snapshotPng);

const snapshotTool = createTool({
  name: 'snapshot',
  // Approval authorization signs the tool's version.
  version: '1.0.0',
  description: 'Takes a snapshot',
  input: z.object({}),
  async execute() {
    return toolContent([
      { type: 'text', text: 'The snapshot:' },
      {
        type: 'image',
        mimeType: 'image/png',
        source: { kind: 'inline', data: snapshotBase64, encoding: 'base64' },
      },
    ]);
  },
});

/** Anthropic rows take images in a tool result. */
const descriptors = createModelCatalog()
  .descriptors.filter((descriptor) => descriptor.provider === 'anthropic')
  .slice(0, 1);

function photographer(seen: GenerateContext[]) {
  return createAgent({
    tools: { snapshot: snapshotTool },
    generate: withBackendDescriptors(async (context: GenerateContext) => {
      seen.push(context);
      const response: GenerateResponse =
        context.step === 0
          ? { content: '', toolCalls: [{ id: 'snap-1', name: 'snapshot', arguments: {} }] }
          : { content: 'Done.', toolCalls: [] };
      return response;
    }, descriptors),
  });
}

describe.each([false, true])('a tool-returned image through Bureau (durable: %p)', (durable) => {
  it('is admitted as the run owner’s asset and resolved for the model; nothing keeps the bytes', async () => {
    const fixture = createMemoryAssetStorageFixture({});
    cleanups.push(() => fixture.dispose());
    const seen: GenerateContext[] = [];
    const bureau = await createBureau({
      agents: { photographer: photographer(seen) },
      assets: { storage: fixture.storage },
      ...(durable ? { storage: { type: 'memory' as const }, durableExecution: true } : {}),
    });
    cleanups.push(async () => {
      await bureau.dispose();
    });

    const run = bureau.run('photographer', 'Take a snapshot', { principal: alice.id });
    const result = await run.result();
    expect(result.finishReason).not.toBe('error');

    const row = result.conversation.getMessages().find((message) => message.role === 'tool-result');
    expect(row?.toolResult?.outcome).toBe('success');
    const [text, image] = row?.toolResult?.parts ?? [];
    expect(text).toEqual({ type: 'text', text: 'The snapshot:' });
    expect(image).toMatchObject({ type: 'image', source: { kind: 'managed-asset' } });
    const source = (image as { source: { kind: 'managed-asset'; assetId: string } }).source;

    // The asset belongs to the run's principal; another principal is refused.
    const descriptor = await bureau.assets!.inspect(source.assetId, alice);
    expect(descriptor.owner).toBe(alice.id);
    const resolved = await bureau.assets!.resolve(source, alice);
    expect(resolved.content).toEqual({ kind: 'bytes', bytes: snapshotPng });
    let denied: unknown;
    try {
      await bureau.assets!.resolve(source, bob);
    } catch (error) {
      denied = error;
    }
    expect(denied).toBeDefined();

    // The second generate call sees the tool result row with the managed reference.
    const second = seen.find((context) => context.step === 1);
    const replayed = second?.conversation
      .getMessages()
      .find((message) => message.role === 'tool-result');
    expect(replayed?.toolResult?.parts?.[1]).toMatchObject({ source: { kind: 'managed-asset' } });
    // ...and the run's resolver has projected that part to the asset's bytes for the provider.
    expect(second?.resolvedSources?.get(`${replayed?.id}:1`)).toMatchObject({
      outcome: 'resolved',
      source: { kind: 'inline', data: snapshotBase64 },
    });

    // Neither the conversation nor the audit trail holds the bytes.
    expect(JSON.stringify(result.conversation.current)).not.toContain(snapshotBase64);
    const audit = (await bureau.auditTrail?.query({ runId: run.id })) ?? [];
    expect(JSON.stringify(audit)).not.toContain(snapshotBase64);

    expect(await run.closed()).toEqual({ status: 'completed' });
  });
});

describe('a tool-returned image through an approved review', () => {
  it('is admitted as the run owner’s asset before the session keeps it', async () => {
    const fixture = createMemoryAssetStorageFixture({});
    cleanups.push(() => fixture.dispose());
    const gated = createToolbox([snapshotTool], {
      approvalSecret: 'tool-result-media-approval',
      policy: {
        beforeExecute: () => ({
          allow: false,
          status: 'needs_approval',
          reason: 'Operator approval required',
          action: { message: 'Approve snapshot' },
        }),
      },
    }) as unknown as Toolbox;
    let step = 0;
    const bureau = await createBureau({
      agents: {
        photographer: createAgent({
          toolbox: gated,
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
          generate: withBackendDescriptors(async () => {
            step += 1;
            const response: GenerateResponse =
              step === 1
                ? { content: '', toolCalls: [{ id: 'snap-1', name: 'snapshot', arguments: {} }] }
                : { content: 'Done.', toolCalls: [] };
            return response;
          }, descriptors),
        }),
      },
      assets: { storage: fixture.storage },
      storage: { type: 'memory' },
      durableExecution: false,
    });
    cleanups.push(async () => {
      await bureau.dispose();
    });

    const run = await bureau.createRun({
      agentName: 'photographer',
      message: 'Take a snapshot',
      principal: alice.id,
    });
    await waitForRunState(bureau, run.id);
    for (let turn = 0; turn < 10; turn++) await yieldToPortableEventLoop();
    const [review] = bureau.listPendingReviews();
    expect(review?.kind).toBe('tool-approval');
    await bureau.resolveReview({ id: review!.id, decision: 'approve', principal: alice.id });

    const session = await bureau.getSession(run.sessionId);
    const history = session!.conversationHistory;
    const row = history.ids
      .map((id) => history.messages[id]!)
      .find((message) => message.toolResult?.callId === 'snap-1');
    expect(row?.toolResult?.outcome).toBe('success');
    const image = row?.toolResult?.parts?.[1];
    expect(image).toMatchObject({ type: 'image', source: { kind: 'managed-asset' } });
    const source = (image as { source: { kind: 'managed-asset'; assetId: string } }).source;
    const descriptor = await bureau.assets!.inspect(source.assetId, alice);
    expect(descriptor.owner).toBe(alice.id);
    expect(JSON.stringify(session)).not.toContain(snapshotBase64);
  });
});
