/**
 * The history slot a continuation naming an `expectedRevision` reserves (COR-1694), under the
 * interleavings its cleanup must survive: an exact retry that claims afresh the moment a refused
 * attempt releases its claim, and a reservation write that commits with its response lost.
 */
import {
  createModelCatalog,
  type GenerateFunction,
  withBackendDescriptors,
} from '@lostgradient/operative';
import type { ConditionalTextValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../test';
import { base64Of, pngBytes } from '../testing/asset-fixtures.test-support.ts';
import { COMMAND_RECEIPTS_EXTENSION_URI } from './a2a-command-receipts.ts';
import {
  call,
  type Json,
  message,
  PUBLIC_URL,
  send,
  sendForTask,
  withA2A,
} from './a2a-mount.test-support.ts';
import { A2A_SEND_LEDGER_KEY_PREFIX } from './a2a-request-handler.ts';
import { A2A_TASK_RECORD_KEY_PREFIX, createA2ATaskRecords } from './a2a-task-record.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import { authentication } from './management/management-fixtures.test-support.ts';

type Batch = ConditionalTextValueStore['conditionalBatch'];
type Operations = Parameters<Batch>[1];

/** Holds its first step until released, so the task is still working while input reaches it. */
function gated(): { generate: GenerateFunction; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  return {
    release: () => release(),
    generate: async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { content: `reply ${calls}`, toolCalls: [] };
    },
  };
}

/**
 * `kv`, with `after` run once, after the first committed batch whose operations `matches`: it
 * returns whether the batch's caller should then see it throw.
 */
function hooked(
  kv: ConditionalTextValueStore,
  matches: (operations: Operations) => boolean,
  after: () => Promise<boolean>,
): ConditionalTextValueStore {
  let armed = true;
  return new Proxy(kv, {
    get(target, property, receiver) {
      if (property === 'conditionalBatch') {
        return async (...arguments_: Parameters<Batch>) => {
          const committed = await target.conditionalBatch(...arguments_);
          if (committed && armed && matches(arguments_[1])) {
            armed = false;
            if (await after()) throw new Error('the connection was lost after the write');
          }
          return committed;
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const activated = { headers: { 'A2A-Extensions': COMMAND_RECEIPTS_EXTENSION_URI } };
const receiptsOf = (task: Json): Json => task.metadata[COMMAND_RECEIPTS_EXTENSION_URI];

describe('a refused continuation’s history slot', () => {
  it('is given back before its claim is released, so an exact retry that claims afresh keeps its entry', async () => {
    const run = gated();
    await withA2A({ asker: run.generate }, async (opened) => {
      const started = await sendForTask(
        opened,
        'asker',
        { message: message('start'), configuration: { returnImmediately: true } },
        activated,
      );
      const revision = receiptsOf(started).revision;
      const sent = {
        message: message('the retried input', {
          taskId: started.id,
          metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { expectedRevision: revision } },
        }),
        configuration: { returnImmediately: true },
      };
      let retried: Json;
      // The refusing instance: the moment its claim is released, the exact retry runs on the
      // other instance, to the end, before the refused attempt goes on.
      const refusing = {
        ...opened,
        handler: createBureauHandler(
          Object.create(opened.bureau, {
            submitSessionInput: {
              value: () => Promise.resolve({ outcome: 'session-terminal' }),
            },
            internals: {
              value: {
                ...opened.bureau.internals,
                kv: hooked(
                  opened.bureau.internals.kv!,
                  (operations) =>
                    operations.some(
                      (operation) =>
                        operation.type === 'delete' &&
                        operation.key.startsWith(A2A_SEND_LEDGER_KEY_PREFIX),
                    ),
                  async () => {
                    retried = await send(opened, 'asker', sent, activated);
                    return false;
                  },
                ),
              },
            },
          }),
          { authentication, publish: ['asker'], publicUrl: PUBLIC_URL },
        ),
      };

      const refused = await send(refusing, 'asker', sent, activated);

      expect(refused.body.error).toBeDefined();
      expect(retried.body.error).toBeUndefined();
      const stored = await createA2ATaskRecords(opened.bureau.internals.kv!).read(started.id);
      expect(JSON.stringify(stored?.history)).toContain('the retried input');
      run.release();
      await waitForCondition(async () => {
        const read = await call(opened, 'asker', 'GetTask', { id: started.id });
        return read.body.result.status.state === 'TASK_STATE_COMPLETED';
      }, 'the task never completed');
    });
  });
});

describe('a reservation whose write committed with its response lost', () => {
  const vision = createModelCatalog()
    .descriptors.filter((descriptor) => descriptor.provider === 'anthropic')
    .slice(0, 1);

  it('keeps the assets its committed entry names', async () => {
    const run = gated();
    await withA2A({ seer: withBackendDescriptors(run.generate, vision) }, async (opened) => {
      const key = { key: 'alice-assets-key', ...activated };
      const started = await sendForTask(
        opened,
        'seer',
        { message: message('start'), configuration: { returnImmediately: true } },
        key,
      );
      const revision = receiptsOf(started).revision;
      const continued = message('Look.', {
        taskId: started.id,
        metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { expectedRevision: revision } },
      });
      continued.parts.push({ raw: base64Of(pngBytes(4, 3, 64)), mediaType: 'image/png' });
      const losing = {
        ...opened,
        handler: createBureauHandler(
          Object.create(opened.bureau, {
            internals: {
              value: {
                ...opened.bureau.internals,
                kv: hooked(
                  opened.bureau.internals.kv!,
                  (operations) =>
                    operations.some(
                      (operation) =>
                        operation.type === 'set' &&
                        operation.key.startsWith(A2A_TASK_RECORD_KEY_PREFIX) &&
                        operation.value.includes(continued.messageId),
                    ),
                  async () => true,
                ),
              },
            },
          }),
          { authentication, publish: ['seer'], publicUrl: PUBLIC_URL },
        ),
      };

      const lost = await send(
        losing,
        'seer',
        { message: continued, configuration: { returnImmediately: true } },
        key,
      );

      expect(lost.body.error).toBeDefined();
      const stored = await createA2ATaskRecords(opened.bureau.internals.kv!).read(started.id);
      const entry: Json = stored?.history.find((held) => held['messageId'] === continued.messageId);
      const url: string = entry.parts.find((part: Json) => part.url !== undefined).url;
      const assetId = decodeURIComponent(
        url.slice(`${PUBLIC_URL}/assets/`.length, -'/content'.length),
      );
      const kept = await opened.bureau.assets!.inspect(assetId, { id: 'api-key:alice' });
      expect(kept.state).toBe('available');
      run.release();
    });
  });
});
