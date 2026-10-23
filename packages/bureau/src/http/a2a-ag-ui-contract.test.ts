/**
 * COR-788, part 2 — one multimodal exchange through A2A and through AG-UI, on one Bureau: both
 * protocols hand the model the same normalized native input (a text part and the caller's managed
 * image asset), end in the same terminal result, and name the same asset.
 */
import { EventType } from '@ag-ui/core';
import { createAgent, createModelCatalog, withBackendDescriptors } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { pngBytes } from '../testing/asset-fixtures.test-support.ts';
import { as, runAgentInput, startRequest } from './ag-ui-fixtures.test-support.ts';
import { readAgUiStream } from './ag-ui-stream.test-support.ts';
import { openBureau } from './management/management-fixtures.test-support.ts';

const PUBLIC_URL = 'http://localhost';
const ALICE = 'api-key:alice';

const vision = createModelCatalog()
  .descriptors.filter((descriptor) => descriptor.provider === 'anthropic')
  .slice(0, 1);

describe('a multimodal exchange through A2A and AG-UI', () => {
  it('reaches the model as the same native input, ends in the same result, and names the same asset', async () => {
    const received: unknown[] = [];
    const opened = await openBureau({
      agents: {
        seer: createAgent({
          name: 'seer',
          generate: withBackendDescriptors(async ({ conversation }) => {
            received.push(conversation.getMessages().at(-1)?.content);
            return { content: 'A small image.', toolCalls: [] };
          }, vision),
        }),
      },
      publish: ['seer'],
      handlerOptions: { publicUrl: PUBLIC_URL, agUi: {} },
    });
    try {
      const admission = await opened.bureau.assets!.admit(
        { source: { kind: 'inline', bytes: pngBytes(4, 3, 64) } },
        { id: ALICE },
      );
      await admission.work.result();
      const { assetId } = admission;

      // A2A: the file part is the asset's route.
      const response = await opened.handler(
        new Request(`${PUBLIC_URL}/a2a/seer`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'A2A-Version': '1.0',
            'X-API-Key': 'alice-assets-key',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'SendMessage',
            params: {
              message: {
                messageId: 'contract-user',
                role: 'ROLE_USER',
                parts: [
                  { text: 'What is this?' },
                  { url: `${PUBLIC_URL}/assets/${assetId}/content`, mediaType: 'image/png' },
                ],
              },
            },
          }),
        }),
      );
      const sent: { result: any } = await response.json();
      const task = sent.result.task ?? sent.result;

      // AG-UI: the same message, the asset as a `bureau` file part.
      const frames = await readAgUiStream(
        await opened.handler(
          startRequest(
            runAgentInput({
              threadId: 'contract-thread',
              runId: 'contract-run',
              messages: [
                {
                  id: 'contract-user',
                  role: 'user',
                  content: [
                    { type: 'text', text: 'What is this?' },
                    {
                      type: 'image',
                      source: {
                        type: 'file',
                        value: assetId,
                        provider: 'bureau',
                        mimeType: 'image/png',
                      },
                    },
                  ],
                },
              ],
            }),
            as('alice-assets-key'),
            'seer',
          ),
        ),
      );
      expect(frames.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);

      expect(task.status.state).toBe('TASK_STATE_COMPLETED');
      expect(received).toHaveLength(2);
      expect(received[0]).toEqual(received[1]);

      const a2a = (await opened.bureau.getSession(task.contextId))!.conversationHistory;
      const agUi = (await opened.bureau.getSession('contract-thread'))!.conversationHistory;
      const rows = (history: typeof a2a) => ({
        user: Object.values(history.messages).find((row) => row.role === 'user')!.content,
        reply: Object.values(history.messages).find((row) => row.role === 'assistant')!.content,
      });
      expect(rows(a2a)).toEqual(rows(agUi));
      expect(rows(a2a).user).toEqual([
        { type: 'text', text: 'What is this?' },
        { type: 'image', mimeType: 'image/png', source: { kind: 'managed-asset', assetId } },
      ]);
      expect(rows(a2a).reply).toBe('A small image.');
    } finally {
      await opened.dispose();
    }
  });
});
