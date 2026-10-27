/**
 * COR-788, part 2 — the files and data an A2A caller sends. Every case starts at the JSON-RPC
 * boundary: a file part on the asset route is the caller's own asset or nothing; inline bytes are
 * admitted as the caller's asset and the history keeps the route, never the bytes; any other
 * address is refused; and a part the card does not advertise is `-32005` before a model is called.
 */
import { createAgent, createModelCatalog, withBackendDescriptors } from '@lostgradient/operative';
import type { GenerateFunction } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { base64Of, pngBytes, wavBytes } from '../testing/asset-fixtures.test-support.ts';
import { COMMAND_RECEIPTS_EXTENSION_URI } from './a2a-command-receipts.ts';
import { type OpenedBureau, openBureau } from './management/management-fixtures.test-support.ts';

const PUBLIC_URL = 'http://localhost';
const ALICE = 'api-key:alice';
const BOB = 'api-key:bob';

// A JSON-RPC body read back from the wire: each test asserts the shape it needs.
type Json = any;

/** A model that takes images and documents in, as a vision model does. */
const vision = createModelCatalog()
  .descriptors.filter((descriptor) => descriptor.provider === 'anthropic')
  .slice(0, 1);

type Seen = { calls: number; rows: Json[] };

/** A vision agent that records the last row it was handed and answers "seen". */
function seeing(seen: Seen): GenerateFunction {
  return withBackendDescriptors(async ({ conversation }) => {
    seen.calls += 1;
    seen.rows.push(conversation.getMessages().at(-1));
    return { content: 'seen', toolCalls: [] };
  }, vision);
}

async function withAgents<T>(
  agents: Record<string, GenerateFunction>,
  body: (opened: OpenedBureau) => Promise<T>,
  options: Parameters<typeof openBureau>[0] = {},
): Promise<T> {
  const opened = await openBureau({
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, generate]) => [name, createAgent({ name, generate })]),
    ),
    publish: Object.keys(agents),
    handlerOptions: { publicUrl: PUBLIC_URL },
    ...options,
  });
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

let counter = 0;

async function call(
  opened: OpenedBureau,
  agent: string,
  method: string,
  params: Json,
  key = 'alice-assets-key',
): Promise<Json> {
  const response = await opened.handler(
    new Request(`${PUBLIC_URL}/a2a/${agent}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return response.json();
}

function messageWith(parts: Json[], extra: Json = {}): Json {
  counter += 1;
  return { messageId: `inbound-${counter}`, role: 'ROLE_USER', parts, ...extra };
}

const send = (opened: OpenedBureau, agent: string, message: Json, key?: string, extra: Json = {}) =>
  call(opened, agent, 'SendMessage', { message, ...extra }, key);

const routeOf = (assetId: string) => `${PUBLIC_URL}/assets/${assetId}/content`;

async function admit(opened: OpenedBureau, bytes: Uint8Array, owner = ALICE): Promise<string> {
  const admission = await opened.bureau.assets!.admit(
    { source: { kind: 'inline', bytes } },
    { id: owner },
  );
  await admission.work.result();
  return admission.assetId;
}

/** How many assets have started admission: the count an exact retry must leave alone. */
async function admissions(opened: OpenedBureau): Promise<number> {
  const records = await opened.bureau.assets!.auditRecords();
  return records.filter((record) => record.type === 'asset.admission.started').length;
}

/** The one user row a task's context holds: its row id follows from the whole command. */
async function userRowOf(opened: OpenedBureau, contextId: string): Promise<Json> {
  const session = await opened.bureau.contexts.get(contextId);
  const rows = Object.values(session!.conversationHistory.messages).filter(
    (row) => row.role === 'user',
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

const png = (padding = 32) => pngBytes(4, 3, padding);

describe('the Agent Card’s input modes', () => {
  it('lists the media a model reads, only where the Bureau has an asset service to hold it', async () => {
    await withAgents(
      {
        plain: async () => ({ content: 'hi', toolCalls: [] }),
        seer: seeing({ calls: 0, rows: [] }),
      },
      async (opened) => {
        const cards: Record<string, Json> = {};
        for (const name of ['plain', 'seer']) {
          const response = await opened.handler(
            new Request(`${PUBLIC_URL}/a2a/${name}/.well-known/agent-card.json`),
          );
          cards[name] = await response.json();
        }
        expect(cards['plain'].defaultInputModes).toEqual(['text/plain', 'application/json']);
        expect(cards['seer'].defaultInputModes).toEqual([
          'text/plain',
          'application/json',
          'image/*',
          'application/pdf',
        ]);
      },
    );
  });

  it('narrows to what the asset policy admits', async () => {
    await withAgents(
      { seer: seeing({ calls: 0, rows: [] }) },
      async (opened) => {
        const response = await opened.handler(
          new Request(`${PUBLIC_URL}/a2a/seer/.well-known/agent-card.json`),
        );
        const card: Json = await response.json();
        expect(card.defaultInputModes).toEqual(['text/plain', 'application/json', 'image/png']);
      },
      { assetPolicy: { allowedMediaTypes: ['image/png'] } },
    );
  });
});

describe('a file part on this server’s asset route', () => {
  it('becomes a managed-asset part of the caller’s own asset, and the history keeps the route', async () => {
    const seen: Seen = { calls: 0, rows: [] };
    await withAgents({ seer: seeing(seen) }, async (opened) => {
      const assetId = await admit(opened, png());
      const body = await send(
        opened,
        'seer',
        messageWith([
          { text: 'What is this?' },
          { url: routeOf(assetId), filename: 'cat.png', mediaType: 'image/png' },
        ]),
      );

      const task = body.result.task ?? body.result;
      expect(task.status.state).toBe('TASK_STATE_COMPLETED');
      const row = await userRowOf(opened, task.contextId);
      expect(row.content).toEqual([
        { type: 'text', text: 'What is this?' },
        {
          type: 'image',
          mimeType: 'image/png',
          name: 'cat.png',
          source: { kind: 'managed-asset', assetId },
        },
      ]);
      expect(task.history[0].parts[1]).toMatchObject({
        url: routeOf(assetId),
        mediaType: 'image/png',
      });
      expect(seen.calls).toBe(1);
    });
  });

  it('needs no media type: the asset’s detected type is the one checked against the card', async () => {
    await withAgents({ seer: seeing({ calls: 0, rows: [] }) }, async (opened) => {
      const assetId = await admit(opened, png());
      const body = await send(opened, 'seer', messageWith([{ url: routeOf(assetId) }]));
      expect((body.result.task ?? body.result).status.state).toBe('TASK_STATE_COMPLETED');
    });
  });

  it('is refused, for any address that is not this server’s asset route, as -32602 before a model is called', async () => {
    const seen: Seen = { calls: 0, rows: [] };
    await withAgents({ seer: seeing(seen) }, async (opened) => {
      const assetId = await admit(opened, png());
      const addresses = [
        'https://example.com/cat.png',
        `https://other.example/assets/${assetId}/content`,
        `${routeOf(assetId)}?download=1`,
        `${routeOf(assetId)}#top`,
        `${PUBLIC_URL}/assets/${assetId}/content/extra`,
        `${PUBLIC_URL}/assets/${assetId}/../${assetId}/content`,
        'file:///etc/passwd',
        'data:image/png;base64,AAAA',
      ];
      for (const url of addresses) {
        const body = await send(
          opened,
          'seer',
          messageWith([{ text: 'x' }, { url, mediaType: 'image/png' }]),
        );
        expect(body.error?.code).toBe(-32602);
      }
      expect(seen.calls).toBe(0);
    });
  });

  it('reads as one answer when the asset is another owner’s, never existed, was deleted, or the caller may not read assets', async () => {
    const seen: Seen = { calls: 0, rows: [] };
    await withAgents({ seer: seeing(seen) }, async (opened) => {
      const others = await admit(opened, png(40), BOB);
      const deleted = await admit(opened, png(41));
      await opened.bureau.assets!.delete(deleted, { id: ALICE }).result();
      const own = await admit(opened, png(42));
      const cases: [string, string][] = [
        [others, 'alice-assets-key'],
        ['asset-never-admitted', 'alice-assets-key'],
        [deleted, 'alice-assets-key'],
        [own, 'alice-key'],
      ];
      const answers: string[] = [];
      for (const [assetId, key] of cases) {
        const body = await send(
          opened,
          'seer',
          messageWith([{ text: 'x' }, { url: routeOf(assetId), mediaType: 'image/png' }]),
          key,
        );
        expect(body.error?.code).toBe(-32602);
        answers.push(String(body.error.message).replaceAll(assetId, '<id>'));
      }
      expect(new Set(answers).size).toBe(1);
      // Nothing was added: no model ran and the caller has no task.
      expect(seen.calls).toBe(0);
      const listed = await call(opened, 'seer', 'ListTasks', {});
      expect(listed.result.tasks ?? []).toEqual([]);
    });
  });

  it('reads an expired asset as it reads a missing one', async () => {
    await withAgents({ seer: seeing({ calls: 0, rows: [] }) }, async (opened) => {
      const assetId = await admit(opened, png());
      await opened.bureau.assets!.expire(assetId, { id: ALICE });
      const body = await send(
        opened,
        'seer',
        messageWith([{ text: 'x' }, { url: routeOf(assetId) }]),
      );
      expect(body.error?.code).toBe(-32602);
      expect(body.error.message).toBe(`Asset '${assetId}' was not found.`);
    });
  });
});

describe('inline bytes', () => {
  it('are admitted as the caller’s asset, enter the run as that asset, and never reach the history', async () => {
    const seen: Seen = { calls: 0, rows: [] };
    await withAgents({ seer: seeing(seen) }, async (opened) => {
      const bytes = png(48);
      const body = await send(
        opened,
        'seer',
        messageWith([
          { text: 'Look.' },
          { raw: base64Of(bytes), filename: 'dot.png', mediaType: 'image/png' },
        ]),
      );

      const task = body.result.task ?? body.result;
      expect(task.status.state).toBe('TASK_STATE_COMPLETED');
      const [, file] = task.history[0].parts;
      expect(file.raw).toBeUndefined();
      expect(file).toMatchObject({ filename: 'dot.png', mediaType: 'image/png' });
      const assetId = decodeURIComponent(
        (file.url as string).slice(`${PUBLIC_URL}/assets/`.length, -'/content'.length),
      );
      const descriptor = await opened.bureau.assets!.inspect(assetId, { id: ALICE });
      expect(descriptor).toMatchObject({
        owner: ALICE,
        state: 'available',
        mediaType: 'image/png',
      });

      const row = await userRowOf(opened, task.contextId);
      expect(row.content).toMatchObject([
        { type: 'text', text: 'Look.' },
        { type: 'image', source: { kind: 'managed-asset', assetId } },
      ]);
      // Neither the response, a later read, nor the stored row holds the bytes.
      const read = await call(opened, 'seer', 'GetTask', { id: task.id });
      for (const text of [JSON.stringify(body), JSON.stringify(read), JSON.stringify(row)]) {
        expect(text).not.toContain(base64Of(bytes));
      }
      expect(read.result.history[0].parts[1].url).toBe(file.url);
    });
  });

  it('are refused, without a model call or an asset, when the card does not advertise the type or the bytes contradict it', async () => {
    const seen: Seen = { calls: 0, rows: [] };
    await withAgents(
      { seer: seeing(seen), plain: async () => ({ content: 'hi', toolCalls: [] }) },
      async (opened) => {
        const before = await admissions(opened);
        const wav = { raw: base64Of(wavBytes()), mediaType: 'audio/wav' };
        const audio = await send(opened, 'seer', messageWith([{ text: 'x' }, wav]));
        const toPlain = await send(
          opened,
          'plain',
          messageWith([{ text: 'x' }, { raw: base64Of(png()), mediaType: 'image/png' }]),
        );
        const mislabeled = await send(
          opened,
          'seer',
          messageWith([{ text: 'x' }, { raw: base64Of(wavBytes()), mediaType: 'image/png' }]),
        );
        const untyped = await send(
          opened,
          'seer',
          messageWith([{ text: 'x' }, { raw: base64Of(png()) }]),
        );

        expect([audio, toPlain, untyped].map((body) => body.error?.code)).toEqual([
          -32005, -32005, -32005,
        ]);
        expect(mislabeled.error?.code).toBe(-32005);
        expect(seen.calls).toBe(0);
        // The mislabeled file was admitted far enough to be inspected, then deleted.
        const after = await admissions(opened);
        expect(after - before).toBeLessThanOrEqual(1);
      },
    );
  });

  it('are refused as -32602 when they exceed what the server admits inline', async () => {
    await withAgents(
      { seer: seeing({ calls: 0, rows: [] }) },
      async (opened) => {
        const body = await send(
          opened,
          'seer',
          messageWith([{ text: 'x' }, { raw: base64Of(png(512)), mediaType: 'image/png' }]),
        );
        expect(body.error?.code).toBe(-32602);
      },
      { assetPolicy: { maxInlineBytes: 128 } },
    );
  });

  it('are refused to a caller without bureau.assets:write', async () => {
    await withAgents({ seer: seeing({ calls: 0, rows: [] }) }, async (opened) => {
      const body = await send(
        opened,
        'seer',
        messageWith([{ text: 'x' }, { raw: base64Of(png()), mediaType: 'image/png' }]),
        'alice-key',
      );
      expect(body.error?.code).toBe(-32602);
    });
  });

  it('admit one asset for an exact retry, and the retry returns the original task', async () => {
    await withAgents({ seer: seeing({ calls: 0, rows: [] }) }, async (opened) => {
      const message = messageWith([
        { text: 'Look.' },
        { raw: base64Of(png(52)), mediaType: 'image/png' },
      ]);
      const first = await send(opened, 'seer', message);
      const admittedOnce = await admissions(opened);
      const second = await send(opened, 'seer', message);

      expect((second.result.task ?? second.result).id).toBe((first.result.task ?? first.result).id);
      expect(await admissions(opened)).toBe(admittedOnce);
      expect(admittedOnce).toBe(1);
    });
  });

  it('stay with the claim when creating the run fails in a way that may have created it, and the retry delivers them', async () => {
    await withAgents({ seer: seeing({ calls: 0, rows: [] }) }, async (opened) => {
      const real = opened.bureau.tasks.start.bind(opened.bureau.tasks);
      let failures = 1;
      opened.bureau.tasks.start = async (...args: Parameters<typeof real>) => {
        const run = await real(...args);
        if (failures > 0) {
          failures -= 1;
          throw new Error('the connection was lost after the run was created');
        }
        return run;
      };
      const message = messageWith([
        { text: 'Look.' },
        { raw: base64Of(png(70)), mediaType: 'image/png' },
      ]);

      const lost = await send(opened, 'seer', message);
      expect(lost.error).toBeDefined();
      const retried = await send(opened, 'seer', message);

      const task = retried.result.task ?? retried.result;
      expect(task.status.state).toBe('TASK_STATE_COMPLETED');
      expect(await admissions(opened)).toBe(1);
      const assetId = decodeURIComponent(
        task.history[0].parts[1].url.slice(`${PUBLIC_URL}/assets/`.length, -'/content'.length),
      );
      const kept = await opened.bureau.assets!.inspect(assetId, { id: ALICE });
      expect(kept.state).toBe('available');
    });
  });

  it('are released when the task is not created: a context another caller owns', async () => {
    await withAgents({ seer: seeing({ calls: 0, rows: [] }) }, async (opened) => {
      const stranger = await opened.bureau.tasks.start('seer', 'mine', { principal: BOB });
      const body = await send(
        opened,
        'seer',
        messageWith([{ text: 'x' }, { raw: base64Of(png(60)), mediaType: 'image/png' }], {
          contextId: stranger.contextId,
        }),
      );
      expect(body.error?.code).toBe(-32001);

      const records = await opened.bureau.assets!.auditRecords();
      const started = records.find((record) => record.type === 'asset.admission.started');
      const assetId = started?.assetId;
      if (assetId !== undefined) {
        const descriptor = await opened.bureau.assets!.inspect(assetId, { id: ALICE });
        expect(descriptor.state).toBe('deleted');
      }
    });
  });
});

describe('a data part', () => {
  it('enters a task as a JSON document for an agent that reads documents, and is ignored by one that reads none', async () => {
    const seen: Seen = { calls: 0, rows: [] };
    await withAgents(
      { seer: seeing(seen), plain: async () => ({ content: 'hi', toolCalls: [] }) },
      async (opened) => {
        const data = { data: { order: 7 }, mediaType: 'application/json' };
        const reading = await send(opened, 'seer', messageWith([{ text: 'Here.' }, data]));
        const row = seen.rows.at(-1);
        expect(row.content).toMatchObject([
          { type: 'text', text: 'Here.' },
          { type: 'document', mimeType: 'application/json' },
        ]);
        expect((reading.result.task ?? reading.result).history[0].parts[1].data).toEqual({
          order: 7,
        });

        const ignoring = await send(opened, 'plain', messageWith([{ text: 'Here.' }, data]));
        expect((ignoring.result.task ?? ignoring.result).status.state).toBe('TASK_STATE_COMPLETED');
      },
    );
  });
});

describe('a message to a working task', () => {
  it('delivers a file part on the asset route as session input, and records the route in the history', async () => {
    await withAgents(
      {
        asker: withBackendDescriptors(
          (async ({ signal }: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) =>
              signal?.addEventListener('abort', () => reject(new Error('aborted'))),
            )) as unknown as GenerateFunction,
          vision,
        ),
      },
      async (opened) => {
        const assetId = await admit(opened, png());
        const submitted: Json[] = [];
        const original = opened.bureau.contexts.input.bind(opened.bureau);
        opened.bureau.contexts.input = ((sessionId: string, request: Json) => {
          submitted.push(request);
          return original(sessionId, request);
        }) as typeof opened.bureau.contexts.input;

        const working = await send(opened, 'asker', messageWith([{ text: 'start' }]), undefined, {
          configuration: { returnImmediately: true },
        });
        const taskId = (working.result.task ?? working.result).id;
        const followUp = await send(
          opened,
          'asker',
          messageWith([{ text: 'and this' }, { url: routeOf(assetId), mediaType: 'image/png' }], {
            taskId,
          }),
          undefined,
          { configuration: { returnImmediately: true } },
        );

        expect(followUp.error).toBeUndefined();
        expect(submitted).toHaveLength(1);
        expect(submitted[0].payload).toEqual([
          { type: 'text', text: 'and this' },
          { type: 'image', mimeType: 'image/png', source: { kind: 'managed-asset', assetId } },
        ]);
        const task = followUp.result.task ?? followUp.result;
        expect(task.history.at(-1).parts[1].url).toBe(routeOf(assetId));
      },
    );
  });

  it('refuses a file part as an answer to a wait, and leaves the wait open', async () => {
    let calls = 0;
    const asks: GenerateFunction = withBackendDescriptors(async () => {
      calls += 1;
      return {
        content: '',
        toolCalls: [
          {
            id: 'wait-1',
            name: 'requestHumanInput',
            arguments: { signalName: 'where', prompt: 'Where?' },
          },
        ],
      };
    }, vision);
    await withAgents({ asker: asks }, async (opened) => {
      const parked = await send(opened, 'asker', messageWith([{ text: 'start' }]));
      const task = parked.result.task ?? parked.result;
      expect(task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
      const answer = await send(
        opened,
        'asker',
        messageWith([{ raw: base64Of(png()), mediaType: 'image/png' }], { taskId: task.id }),
      );
      expect(answer.error?.code).toBe(-32005);
      const read = await call(opened, 'asker', 'GetTask', { id: task.id });
      expect(read.result.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
      expect(calls).toBe(1);
    });
  });
});

describe('a send whose deadline has already passed', () => {
  const past = '2020-01-01T00:00:00Z';

  async function sendExpired(opened: OpenedBureau, agent: string, message: Json): Promise<Json> {
    const response = await opened.handler(
      new Request(`${PUBLIC_URL}/a2a/${agent}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'A2A-Version': '1.0',
          'X-API-Key': 'alice-assets-key',
          'A2A-Extensions': COMMAND_RECEIPTS_EXTENSION_URI,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: {
            message: {
              ...message,
              metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { deadline: past } },
            },
            configuration: { returnImmediately: true },
          },
        }),
      }),
    );
    return response.json();
  }

  const rawMessage = (extra: Json = {}) =>
    messageWith([{ text: 'x' }, { raw: base64Of(png(80)), mediaType: 'image/png' }], extra);

  it('answers a new task’s raw part with the deadline receipt, every time, and admits nothing', async () => {
    await withAgents(
      { seer: seeing({ calls: 0, rows: [] }) },
      async (opened) => {
        const message = rawMessage();
        const first = await sendExpired(opened, 'seer', message);
        const again = await sendExpired(opened, 'seer', message);

        for (const body of [first, again]) {
          expect(body.error).toBeUndefined();
          const task = body.result.task ?? body.result;
          expect(task.status.state).toBe('TASK_STATE_FAILED');
          expect(task.metadata[COMMAND_RECEIPTS_EXTENSION_URI]).toMatchObject({
            receipt: { state: 'expired', reason: 'deadline-exceeded' },
          });
        }
        expect((again.result.task ?? again.result).id).toBe((first.result.task ?? first.result).id);
        expect(await admissions(opened)).toBe(0);
      },
      { durableHistory: true },
    );
  });

  it('answers a working task’s raw part with the deadline receipt, every time, and admits nothing', async () => {
    await withAgents(
      {
        asker: withBackendDescriptors(
          (async ({ signal }: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) =>
              signal?.addEventListener('abort', () => reject(new Error('aborted'))),
            )) as unknown as GenerateFunction,
          vision,
        ),
      },
      async (opened) => {
        const working = await send(opened, 'asker', messageWith([{ text: 'start' }]), undefined, {
          configuration: { returnImmediately: true },
        });
        const taskId = (working.result.task ?? working.result).id;
        const message = rawMessage({ taskId });
        const first = await sendExpired(opened, 'asker', message);
        const again = await sendExpired(opened, 'asker', message);

        for (const body of [first, again]) {
          expect(body.error).toBeUndefined();
          const task = body.result.task ?? body.result;
          expect(task.metadata[COMMAND_RECEIPTS_EXTENSION_URI]).toMatchObject({
            receipt: { state: 'expired', reason: 'deadline-exceeded' },
          });
        }
        expect(await admissions(opened)).toBe(0);
      },
      { durableHistory: true },
    );
  });
});

/** An agent that parks until its run is aborted, so a task stays working. */
const parked = () =>
  withBackendDescriptors(
    (async ({ signal }: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )) as unknown as GenerateFunction,
    vision,
  );

describe('a retry completes from the claim', () => {
  it('does not read an asset route again: an asset deleted between attempts cannot fail the retry', async () => {
    await withAgents({ seer: seeing({ calls: 0, rows: [] }) }, async (opened) => {
      const assetId = await admit(opened, png(90));
      const real = opened.bureau.tasks.start.bind(opened.bureau.tasks);
      let failures = 1;
      opened.bureau.tasks.start = async (...args: Parameters<typeof real>) => {
        const run = await real(...args);
        if (failures > 0) {
          failures -= 1;
          throw new Error('the connection was lost after the run was created');
        }
        return run;
      };
      const message = messageWith([
        { text: 'x' },
        { url: routeOf(assetId), mediaType: 'image/png' },
      ]);

      const lost = await send(opened, 'seer', message);
      expect(lost.error).toBeDefined();
      await opened.bureau.assets!.delete(assetId, { id: ALICE }).result();
      const retried = await send(opened, 'seer', message);

      expect(retried.error).toBeUndefined();
      const task = retried.result.task ?? retried.result;
      expect(task.history[0].parts[1].url).toBe(routeOf(assetId));
    });
  });

  it('keeps the assets of an input the mailbox may already hold when its admission throws', async () => {
    await withAgents({ asker: parked() }, async (opened) => {
      const working = await send(opened, 'asker', messageWith([{ text: 'start' }]), undefined, {
        configuration: { returnImmediately: true },
      });
      const taskId = (working.result.task ?? working.result).id;
      const real = opened.bureau.contexts.input.bind(opened.bureau);
      let failures = 1;
      opened.bureau.contexts.input = async (sessionId: string, request: Json) => {
        const outcome = await real(sessionId, request);
        if (failures > 0) {
          failures -= 1;
          throw new Error('the mailbox record was committed, then the identity write failed');
        }
        return outcome;
      };
      const message = messageWith(
        [{ text: 'and this' }, { raw: base64Of(png(91)), mediaType: 'image/png' }],
        { taskId },
      );
      const options = { configuration: { returnImmediately: true } };

      const lost = await send(opened, 'asker', message, undefined, options);
      expect(lost.error).toBeDefined();
      const retried = await send(opened, 'asker', message, undefined, options);

      expect(retried.error).toBeUndefined();
      expect(await admissions(opened)).toBe(1);
      const task = retried.result.task ?? retried.result;
      const assetId = decodeURIComponent(
        task.history.at(-1).parts[1].url.slice(`${PUBLIC_URL}/assets/`.length, -'/content'.length),
      );
      const kept = await opened.bureau.assets!.inspect(assetId, { id: ALICE });
      expect(kept.state).toBe('available');
    });
  });
});

describe('inline bytes under the reuse duplicate policy', () => {
  it('are the asset the caller already held, which a refused send never deletes', async () => {
    await withAgents(
      { seer: seeing({ calls: 0, rows: [] }) },
      async (opened) => {
        const bytes = png(92);
        const held = await admit(opened, bytes);
        const sent = await send(
          opened,
          'seer',
          messageWith([{ text: 'x' }, { raw: base64Of(bytes), mediaType: 'image/png' }]),
        );
        const task = sent.result.task ?? sent.result;
        expect(task.history[0].parts[1].url).toBe(routeOf(held));
        const row = await userRowOf(opened, task.contextId);
        expect(row.content[1].source.assetId).toBe(held);

        const stranger = await opened.bureau.tasks.start('seer', 'mine', { principal: BOB });
        const refused = await send(
          opened,
          'seer',
          messageWith([{ text: 'x' }, { raw: base64Of(bytes), mediaType: 'image/png' }], {
            contextId: stranger.contextId,
          }),
        );
        expect(refused.error?.code).toBe(-32001);
        const kept = await opened.bureau.assets!.inspect(held, { id: ALICE });
        expect(kept.state).toBe('available');
      },
      { assetPolicy: { duplicatePolicy: 'reuse' } },
    );
  });
});

describe('a messageId sent to two agents', () => {
  it('creates two tasks, each with its own row', async () => {
    await withAgents(
      { one: seeing({ calls: 0, rows: [] }), two: seeing({ calls: 0, rows: [] }) },
      async (opened) => {
        const message = messageWith([
          { text: 'x' },
          { raw: base64Of(png(93)), mediaType: 'image/png' },
        ]);
        const first = await send(opened, 'one', message);
        const second = await send(opened, 'two', message);
        expect(first.error).toBeUndefined();
        expect(second.error).toBeUndefined();
        expect((first.result.task ?? first.result).id).not.toBe(
          (second.result.task ?? second.result).id,
        );
      },
    );
  });
});

describe('the card under a policy spelled loosely', () => {
  it('reads allowedMediaTypes as admission does: case and parameters ignored', async () => {
    await withAgents(
      { seer: seeing({ calls: 0, rows: [] }) },
      async (opened) => {
        const response = await opened.handler(
          new Request(`${PUBLIC_URL}/a2a/seer/.well-known/agent-card.json`),
        );
        const card: Json = await response.json();
        expect(card.defaultInputModes).toContain('image/png');
        const sent = await send(
          opened,
          'seer',
          messageWith([{ text: 'x' }, { raw: base64Of(png(94)), mediaType: 'image/png' }]),
        );
        expect((sent.result.task ?? sent.result).status.state).toBe('TASK_STATE_COMPLETED');
      },
      { assetPolicy: { allowedMediaTypes: ['IMAGE/PNG; charset=binary'] } },
    );
  });
});

describe('a retry of a URL-only input', () => {
  it('completes from the recorded projection when the mailbox committed and then threw, even if the asset is gone', async () => {
    await withAgents({ asker: parked() }, async (opened) => {
      const assetId = await admit(opened, png(95));
      const working = await send(opened, 'asker', messageWith([{ text: 'start' }]), undefined, {
        configuration: { returnImmediately: true },
      });
      const taskId = (working.result.task ?? working.result).id;
      const real = opened.bureau.contexts.input.bind(opened.bureau);
      let failures = 1;
      opened.bureau.contexts.input = async (sessionId: string, request: Json) => {
        const outcome = await real(sessionId, request);
        if (failures > 0) {
          failures -= 1;
          throw new Error('the mailbox record was committed, then the identity write failed');
        }
        return outcome;
      };
      const message = messageWith(
        [{ text: 'and this' }, { url: routeOf(assetId), mediaType: 'image/png' }],
        { taskId },
      );
      const options = { configuration: { returnImmediately: true } };

      const lost = await send(opened, 'asker', message, undefined, options);
      expect(lost.error).toBeDefined();
      await opened.bureau.assets!.delete(assetId, { id: ALICE }).result();
      const retried = await send(opened, 'asker', message, undefined, options);

      expect(retried.error).toBeUndefined();
      const task = retried.result.task ?? retried.result;
      expect(task.history.at(-1).parts[1].url).toBe(routeOf(assetId));
    });
  });
});

describe('a recorded projection replayed to another credential', () => {
  it('is refused to a same-subject key without the asset scope, and delivers nothing', async () => {
    const seen: Seen = { calls: 0, rows: [] };
    await withAgents({ seer: seeing(seen) }, async (opened) => {
      const assetId = await admit(opened, png(96));
      const real = opened.bureau.tasks.start.bind(opened.bureau.tasks);
      let failures = 1;
      opened.bureau.tasks.start = async (...args: Parameters<typeof real>) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('the store was unavailable');
        }
        return real(...args);
      };
      const message = messageWith([
        { text: 'x' },
        { url: routeOf(assetId), mediaType: 'image/png' },
      ]);

      const lost = await send(opened, 'seer', message, 'alice-assets-key');
      expect(lost.error).toBeDefined();
      const unscoped = await send(opened, 'seer', message, 'alice-key');

      expect(unscoped.error?.code).toBe(-32602);
      expect(unscoped.error.message).toBe(`Asset '${assetId}' was not found.`);
      expect(seen.calls).toBe(0);
      const listed = await call(opened, 'seer', 'ListTasks', {});
      expect(listed.result.tasks ?? []).toEqual([]);
    });
  });
});

describe('a deadline that inline admission overtakes', () => {
  it('discards the newly admitted asset and answers the expired receipt', async () => {
    const seen: Seen = { calls: 0, rows: [] };
    await withAgents(
      { seer: seeing(seen) },
      async (opened) => {
        const deadline = new Date(Date.now() + 250).toISOString();
        const response = await opened.handler(
          new Request(`${PUBLIC_URL}/a2a/seer`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'A2A-Version': '1.0',
              'X-API-Key': 'alice-assets-key',
              'A2A-Extensions': COMMAND_RECEIPTS_EXTENSION_URI,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'SendMessage',
              params: {
                message: {
                  ...messageWith([
                    { text: 'x' },
                    { raw: base64Of(png(97)), mediaType: 'image/png' },
                  ]),
                  metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { deadline } },
                },
                configuration: { returnImmediately: true },
              },
            }),
          }),
        );
        const body: Json = await response.json();

        expect(body.error).toBeUndefined();
        const task = body.result.task ?? body.result;
        expect(task.metadata[COMMAND_RECEIPTS_EXTENSION_URI]).toMatchObject({
          receipt: { state: 'expired', reason: 'deadline-exceeded' },
        });
        expect(seen.calls).toBe(0);
        const records = await opened.bureau.assets!.auditRecords();
        const started = records.find((record) => record.type === 'asset.admission.started');
        const descriptor = await opened.bureau.assets!.inspect(started!.assetId!, { id: ALICE });
        expect(descriptor.state).toBe('deleted');
      },
      {
        assetPorts: {
          safetyGates: [
            {
              name: 'slow',
              inspect: async () => {
                await new Promise((resolve) => setTimeout(resolve, 600));
                return { verdict: 'clean' as const };
              },
            },
          ],
        },
      },
    );
  });
});

describe('the card under an exact allowlist entry', () => {
  it('advertises the exact allowed type, not the descriptor’s whole family', async () => {
    await withAgents(
      { seer: seeing({ calls: 0, rows: [] }) },
      async (opened) => {
        const response = await opened.handler(
          new Request(`${PUBLIC_URL}/a2a/seer/.well-known/agent-card.json`),
        );
        const card: Json = await response.json();
        expect(card.defaultInputModes).toEqual(['text/plain', 'application/json', 'image/png']);
        const jpeg = await send(
          opened,
          'seer',
          messageWith([{ text: 'x' }, { raw: base64Of(png(98)), mediaType: 'image/jpeg' }]),
        );
        expect(jpeg.error?.code).toBe(-32005);
      },
      { assetPolicy: { allowedMediaTypes: ['image/png'] } },
    );
  });
});
