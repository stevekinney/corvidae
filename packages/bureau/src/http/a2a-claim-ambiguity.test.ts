/**
 * COR-1680 — a ledger claim that rejects after it committed. The handler is the real one; the
 * ledger is the real command ledger, wrapped so one claim lands and then reports a failure, as a
 * lost response does. The inline bytes the send admitted are named by the pending claim, so the
 * exact retry must deliver them rather than find them deleted.
 */
import { Message } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { principalFromApiKey } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createCommandLedger } from '../command-ledger.ts';
import { base64Of, pngBytes } from '../testing/asset-fixtures.test-support.ts';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createBureauAgentCard } from './a2a-agent-card.ts';
import {
  A2A_SEND_LEDGER_KEY_PREFIX,
  type A2ASendClaim,
  type A2ASendLedger,
  type A2ASendResult,
  BureauA2AUser,
  createBureauA2ARequestHandler,
} from './a2a-request-handler.ts';
import { createA2ATaskRecords } from './a2a-task-record.ts';
import { buildBureauHandlerHost } from './create-bureau-handler.ts';
import { openBureau } from './management/management-fixtures.test-support.ts';
import { respondToTask } from './management/tasks-respond-operation.ts';

const answers: GenerateFunction = async () => ({ content: 'seen', toolCalls: [] });

describe('a claim that committed and then reported a failure', () => {
  it('keeps the inline assets it admitted, and the exact retry delivers them', async () => {
    const opened = await openBureau({
      agents: { seer: createAgent({ name: 'seer', generate: answers }) },
      a2aAgents: ['seer'],
    });
    try {
      const runtime = createDefaultRuntimeServices();
      const inner = createCommandLedger<A2ASendClaim, A2ASendResult>({
        kv: textValueStore(new MemoryStorage()),
        keyPrefix: A2A_SEND_LEDGER_KEY_PREFIX,
        clock: runtime.clock,
        nextConflictId: () => runtime.identifiers.next('conflict'),
      });
      let loseNextResponse = true;
      const ledger: A2ASendLedger = {
        ...inner,
        async claim(identity, digest, claim) {
          const outcome = await inner.claim(identity, digest, claim);
          if (loseNextResponse) {
            loseNextResponse = false;
            throw new Error('the claim response was lost');
          }
          return outcome;
        },
      };
      const host = buildBureauHandlerHost(opened.bureau, ['seer']);
      const card = createBureauAgentCard({
        catalogName: 'seer',
        displayName: undefined,
        description: undefined,
        definitionRevision: 1,
        skillDescriptors: undefined,
        security: undefined,
        durableHistory: false,
        pushNotifications: false,
        inputModes: ['text/plain', 'image/png'],
      });
      const handler = createBureauA2ARequestHandler({
        publicUrl: 'http://localhost',
        agentName: 'seer',
        card: () => ({ ...card, supportedInterfaces: [], signatures: [] }),
        bureau: opened.bureau,
        records: createA2ATaskRecords(textValueStore(new MemoryStorage())),
        ledger,
        respond: (principal, input) => respondToTask(host, principal, input),
      });
      const principal = principalFromApiKey({
        subject: 'alice',
        scopes: ['bureau.assets:write', 'bureau.assets:read'],
      });
      const send = () =>
        handler.sendMessage(
          {
            tenant: '',
            message: Message.fromJSON({
              messageId: 'm-inline',
              role: 'ROLE_USER',
              parts: [
                { text: 'Look.' },
                { raw: base64Of(pngBytes(4, 3, 55)), mediaType: 'image/png' },
              ],
            }),
            configuration: undefined,
            metadata: undefined,
          },
          new ServerCallContext({ user: new BureauA2AUser(principal), requestedVersion: '1.0' }),
        );

      const lost = await rejectionOf(send());
      expect((lost as Error).message).toBe('the claim response was lost');
      const retried = await send();
      if (!('status' in retried)) throw new Error('expected a task');

      const records = await opened.bureau.assets!.auditRecords();
      const started = records.filter((record) => record.type === 'asset.admission.started');
      expect(started).toHaveLength(1);
      const part = retried.history[0]?.parts[1] as unknown as { content?: { value?: string } };
      const url = part.content?.value ?? '';
      const id = decodeURIComponent(url.slice(url.indexOf('/assets/') + 8, -'/content'.length));
      const kept = await opened.bureau.assets!.inspect(id, { id: `api-key:alice` });
      expect(kept.state).toBe('available');
    } finally {
      await opened.dispose();
    }
  });
});
