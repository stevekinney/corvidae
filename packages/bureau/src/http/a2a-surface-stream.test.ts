/**
 * COR-837, part 3 — A2A streams carry a task's A2UI surface updates. `SendStreamingMessage` and
 * `SubscribeToTask` over a real Bureau with a durable history: a client that activated A2UI's
 * extension gets each surface revision once, as a `statusUpdate` of the current state whose message
 * holds the surface parts a read holds; a torn-down surface sends `deleteSurface`; a frozen one is
 * delivered before the stream ends. A client that did not activate it gets no surface frames.
 */
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { CINDER, createMessage, updateComponentsMessage } from '../a2ui/a2ui.test-support.ts';
import { createA2uiAdapter } from '../a2ui/adapter.ts';
import { INTERACTIVE_SURFACE_CONTRACT_VERSION } from '../interactive-surface/types.ts';
import { A2UI_BASIC_CATALOG_ID, A2UI_EXTENSION_URI } from '../a2ui/catalogs.ts';
import { DURABLE_HISTORY_EXTENSION_URI } from './a2a-task-stream.ts';
import { type OpenedBureau, openBureau } from './management/management-fixtures.test-support.ts';

// A JSON-RPC body read back from the wire: each test asserts the shape it needs.
type Json = any;
type ServerSentEvent = { readonly id: string | undefined; readonly data: Json };

function serverSentEvents(response: Response) {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return {
    async next(): Promise<ServerSentEvent | undefined> {
      for (;;) {
        const boundary = buffered.indexOf('\n\n');
        if (boundary !== -1) {
          const block = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const lines = block.split('\n');
          const data = lines.find((line) => line.startsWith('data:'));
          if (data === undefined) continue;
          const id = lines
            .find((line) => line.startsWith('id:'))
            ?.slice(3)
            .trim();
          return { id, data: JSON.parse(data.slice(5)) };
        }
        const chunk = await reader.read();
        if (chunk.done) return undefined;
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

let counter = 0;
function rpc(method: string, params: Json, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/a2a/asker', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'A2A-Version': '1.0',
      'X-API-Key': 'alice-key',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}
function message(text: string, extra: Json = {}): Json {
  counter += 1;
  return { messageId: `surface-${counter}`, role: 'ROLE_USER', parts: [{ text }], ...extra };
}

function parksThenAnswers(): GenerateFunction {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls === 1
      ? {
          content: '',
          toolCalls: [
            {
              id: 'wait-1',
              name: 'requestHumanInput',
              arguments: { signalName: 'human-response', prompt: 'Which?' },
            },
          ],
        }
      : { content: 'done', toolCalls: [] };
  };
}

const ACTIVATED = { 'A2A-Extensions': `${A2UI_EXTENSION_URI}, ${DURABLE_HISTORY_EXTENSION_URI}` };
const PLAIN = { 'A2A-Extensions': DURABLE_HISTORY_EXTENSION_URI };

function declare(supportedCatalogIds: string[]): Json {
  return { a2uiClientCapabilities: { 'v0.9': { supportedCatalogIds } } };
}

async function withTask(body: (kit: Kit) => Promise<void>): Promise<void> {
  const opened = await openBureau({
    agents: { asker: createAgent({ name: 'asker', generate: parksThenAnswers() }) },
    publish: ['asker'],
    humanInput: true,
    durableHistory: true,
    handlerOptions: { publicUrl: 'http://localhost' },
  });
  try {
    await body(kitOf(opened));
  } finally {
    await opened.dispose();
  }
}

type Kit = ReturnType<typeof kitOf>;

function kitOf(opened: OpenedBureau) {
  const surfaces = opened.bureau.surfaces;
  if (surfaces === undefined) throw new Error('a durable Bureau has surfaces');
  const adapter = createA2uiAdapter({ surfaces });
  let commands = 0;
  /** Parks a task and returns its id. */
  const park = async (): Promise<string> => {
    const sent = await opened.handler(
      rpc('SendMessage', {
        message: message('start'),
        configuration: { returnImmediately: false },
      }),
    );
    const body: Json = await sent.json();
    expect(body.result.task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    return body.result.task.id;
  };
  /** Creates, updates, or deletes a surface on a task as its owner. */
  const apply = async (
    taskId: string,
    options: {
      surfaceId?: string;
      baseRevision?: number;
      messages?: unknown[];
      catalog?: string;
      text?: string;
    } = {},
  ) => {
    const record = await opened.bureau.tasks.record(taskId);
    if (record === undefined) throw new Error('no record');
    commands += 1;
    const surfaceId = options.surfaceId ?? 'panel';
    const receipt = await adapter.apply(
      {
        taskId,
        commandId: `cmd-${commands}`,
        complete: true,
        summary: 'A panel',
        messages: options.messages ?? [
          ...(options.baseRevision === undefined
            ? [createMessage(surfaceId, options.catalog)]
            : []),
          updateComponentsMessage(
            surfaceId,
            options.catalog === undefined
              ? [
                  { id: 'title', component: 'Text', text: options.text ?? 'Pick' },
                  { id: 'root', component: 'Column', children: ['title'] },
                ]
              : [{ id: 'root', component: 'Checkbox', label: options.text ?? 'Accept' }],
          ),
        ],
        ...(options.baseRevision === undefined ? {} : { baseRevision: options.baseRevision }),
        ...(options.catalog === undefined ? {} : { supportedCatalogIds: [options.catalog] }),
      },
      { principal: record.owner },
    );
    expect(receipt.outcome).toBe('accepted');
  };
  const remove = async (taskId: string, surfaceId = 'panel', baseRevision?: number) => {
    await apply(taskId, {
      surfaceId,
      messages: [{ version: 'v0.9.1', deleteSurface: { surfaceId } }],
      ...(baseRevision === undefined ? {} : { baseRevision }),
    });
  };
  const answer = async (taskId: string) => {
    const response = await opened.handler(
      rpc('SendMessage', {
        message: message('blue', { taskId }),
        configuration: { returnImmediately: true },
      }),
    );
    const body: Json = await response.json();
    expect(body.error).toBeUndefined();
  };
  const subscribe = (taskId: string, headers: Record<string, string> = ACTIVATED) =>
    opened.handler(rpc('SubscribeToTask', { id: taskId }, headers));
  const stream = (headers: Record<string, string>, extra: Json = {}) =>
    opened.handler(rpc('SendStreamingMessage', { message: message('start', extra) }, headers));
  const owner = async (taskId: string) => {
    const record = await opened.bureau.tasks.record(taskId);
    return record?.owner;
  };
  return { opened, park, apply, remove, answer, subscribe, stream, surfaces, owner };
}

/** The A2UI data parts of a streamed event's status message, with their metadata. */
function surfaceDataOf(event: ServerSentEvent | undefined): Json[] {
  const parts: Json[] =
    event?.data.result?.statusUpdate?.status?.message?.parts ??
    event?.data.result?.task?.status?.message?.parts ??
    [];
  return parts.filter((part) => part.mediaType === 'application/a2ui+json');
}
const revisionsOf = (event: ServerSentEvent | undefined): string[] =>
  surfaceDataOf(event).map(
    (part) => `${part.metadata.surfaceId}@${part.metadata.a2uiSurfaceRevision}`,
  );
const isSurfaceFrame = (event: ServerSentEvent): boolean =>
  (event.data.result?.statusUpdate?.status?.message?.messageId ?? '').includes(':surfaces:');

async function drain(stream: ReturnType<typeof serverSentEvents>): Promise<ServerSentEvent[]> {
  const events: ServerSentEvent[] = [];
  for (;;) {
    const event = await stream.next();
    if (event === undefined) return events;
    events.push(event);
  }
}

/**
 * A minimal A2UI v0.9.1 client: replays every message a stream delivered and refuses what the
 * specification forbids, a second `createSurface` for a held surface id and an update to a surface
 * that does not exist. Returns the text each surface's components show.
 */
function replayed(events: Array<ServerSentEvent | undefined>): Record<string, string[]> {
  const surfaces = new Map<string, Map<string, Json>>();
  for (const event of events) {
    for (const part of surfaceDataOf(event)) {
      for (const message of part.data as Json[]) {
        if (message.createSurface !== undefined) {
          const { surfaceId } = message.createSurface;
          if (surfaces.has(surfaceId)) throw new Error(`createSurface repeats ${surfaceId}`);
          surfaces.set(surfaceId, new Map());
        } else if (message.deleteSurface !== undefined) {
          surfaces.delete(message.deleteSurface.surfaceId);
        } else {
          const body = message.updateComponents ?? message.updateDataModel;
          const held = surfaces.get(body.surfaceId);
          if (held === undefined) throw new Error(`an update names the absent ${body.surfaceId}`);
          for (const component of message.updateComponents?.components ?? []) {
            held.set(component.id, component);
          }
        }
      }
    }
  }
  return Object.fromEntries(
    [...surfaces].map(([id, components]) => [
      id,
      [...components.values()].flatMap((component) =>
        typeof component.text === 'string' ? [component.text] : [],
      ),
    ]),
  );
}

describe('SubscribeToTask with a surface', () => {
  it('continues a held surface with its whole state and never a second createSurface', async () => {
    await withTask(async (kit) => {
      const taskId = await kit.park();
      const stream = serverSentEvents(await kit.subscribe(taskId));
      const opening = await stream.next();
      await kit.apply(taskId);
      const created = await stream.next();
      await kit.apply(taskId, { baseRevision: 1, text: 'Two' });
      const second = await stream.next();
      await kit.apply(taskId, { baseRevision: 2, text: 'Three' });
      const third = await stream.next();
      const kinds = (event: ServerSentEvent | undefined) =>
        surfaceDataOf(event).flatMap((part) =>
          (part.data as Json[]).map((message) => Object.keys(message).find((k) => k !== 'version')),
        );
      expect(kinds(created)).toEqual(['createSurface', 'updateComponents', 'updateDataModel']);
      expect(kinds(second)).toEqual(['updateComponents', 'updateDataModel']);
      expect(kinds(third)).toEqual(['updateComponents', 'updateDataModel']);
      expect(replayed([opening, created, second, third])).toEqual({ panel: ['Three'] });
      await stream.cancel();
    });
  });

  it('deletes and begins a surface again when an update changes what only createSurface carries', async () => {
    await withTask(async (kit) => {
      const taskId = await kit.park();
      const stream = serverSentEvents(await kit.subscribe(taskId));
      const opening = await stream.next();
      await kit.apply(taskId);
      const created = await stream.next();
      // The adapter cannot restate `createSurface` on an update, but the store accepts a
      // replacement representation that does.
      const principal = await kit.owner(taskId);
      const [held] = await kit.surfaces.list(taskId, { principal });
      if (held?.representation?.kind !== 'a2ui') throw new Error('expected an A2UI surface');
      const updated = await kit.surfaces.update(
        {
          type: 'surface.update',
          contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
          commandId: 'theme-1',
          taskId,
          surfaceId: 'panel',
          baseRevision: held.revision,
          representation: { ...held.representation, sendDataModel: true },
        },
        { principal },
      );
      expect(updated.outcome).toBe('accepted');
      const changed = await stream.next();
      const kinds = surfaceDataOf(changed).flatMap((part) =>
        (part.data as Json[]).map((message) => Object.keys(message).find((k) => k !== 'version')),
      );
      expect(kinds).toEqual([
        'deleteSurface',
        'createSurface',
        'updateComponents',
        'updateDataModel',
      ]);
      expect(surfaceDataOf(changed)[1]?.data[0].createSurface.sendDataModel).toBe(true);
      expect(replayed([opening, created, changed])).toEqual({ panel: ['Pick'] });
      await stream.cancel();
    });
  });

  it.each([
    ['fewer components', [{ id: 'solo', component: 'Text', text: 'Solo' }], ['Solo']],
    ['no components', [], []],
  ])(
    'deletes and begins a surface again when a replacement leaves %s',
    async (_name, components, expected) => {
      await withTask(async (kit) => {
        const taskId = await kit.park();
        const stream = serverSentEvents(await kit.subscribe(taskId));
        const opening = await stream.next();
        await kit.apply(taskId);
        const created = await stream.next();
        const principal = await kit.owner(taskId);
        const [held] = await kit.surfaces.list(taskId, { principal });
        if (held?.representation?.kind !== 'a2ui') throw new Error('expected an A2UI surface');
        const updated = await kit.surfaces.update(
          {
            type: 'surface.update',
            contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
            commandId: 'shrink-1',
            taskId,
            surfaceId: 'panel',
            baseRevision: held.revision,
            representation: { ...held.representation, components },
          },
          { principal },
        );
        expect(updated.outcome).toBe('accepted');
        const changed = await stream.next();
        const kinds = surfaceDataOf(changed).flatMap((part) =>
          (part.data as Json[]).map((message) => Object.keys(message).find((k) => k !== 'version')),
        );
        expect(kinds[0]).toBe('deleteSurface');
        expect(kinds[1]).toBe('createSurface');
        expect(replayed([opening, created, changed])).toEqual({ panel: expected });
        await stream.cancel();
      });
    },
  );

  it('replays an opening snapshot, an update, and a delete as valid A2UI', async () => {
    await withTask(async (kit) => {
      const taskId = await kit.park();
      await kit.apply(taskId);
      const stream = serverSentEvents(await kit.subscribe(taskId));
      const opening = await stream.next();
      await kit.apply(taskId, { baseRevision: 1, text: 'Two' });
      const updated = await stream.next();
      await kit.remove(taskId, 'panel', 2);
      const deleted = await stream.next();
      expect(replayed([opening, updated])).toEqual({ panel: ['Two'] });
      expect(replayed([opening, updated, deleted])).toEqual({});
      await stream.cancel();
    });
  });

  it('sends each revision once as a status update of the current state, ahead of later status frames', async () => {
    await withTask(async (kit) => {
      const taskId = await kit.park();
      const stream = serverSentEvents(await kit.subscribe(taskId));
      const opening = await stream.next();
      expect(opening?.data.result.task.id).toBe(taskId);
      expect(surfaceDataOf(opening)).toHaveLength(0);

      await kit.apply(taskId);
      const created = await stream.next();
      expect(created?.data.result.statusUpdate.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
      expect(revisionsOf(created)).toEqual(['panel@1']);
      expect(surfaceDataOf(created)[0]).toMatchObject({
        mediaType: 'application/a2ui+json',
        metadata: { mimeType: 'application/a2ui+json' },
      });
      expect(created?.id).toBeDefined();

      await kit.apply(taskId, { baseRevision: 1, text: 'Pick again' });
      const updated = await stream.next();
      expect(revisionsOf(updated)).toEqual(['panel@2']);
      expect(Number(updated?.id ?? -1)).toBeGreaterThanOrEqual(0);

      await kit.answer(taskId);
      const rest = await drain(stream);
      const surfaceFrames = rest.filter(isSurfaceFrame);
      // The open surface freezes with the task: its closing revision is delivered before the end.
      expect(surfaceFrames.flatMap(revisionsOf)).toEqual(['panel@3']);
      const states = rest.map((event) => event.data.result.statusUpdate?.status.state);
      expect(states.at(-1)).toBe('TASK_STATE_COMPLETED');
      // Every revision exactly once over the whole stream.
      const all = [created, updated, ...rest].filter((event) => event !== undefined);
      const delivered = all.flatMap(revisionsOf);
      expect(new Set(delivered).size).toBe(delivered.length);
    });
  });

  it('delivers the task-end freeze before the stream closes when the task record lags the run event', async () => {
    await withTask(async (kit) => {
      const taskId = await kit.park();
      // The task record's settlement, which triggers the surface store's own freeze, arrives late:
      // held here until the stream has ended.
      const settled = Promise.withResolvers<void>();
      let released = false;
      const tasks = kit.opened.bureau.tasks;
      const onSettled = tasks.onSettled.bind(tasks);
      const get = tasks.get.bind(tasks);
      tasks.onSettled = (id, listener) =>
        onSettled(id, (...args) => settled.promise.then(() => listener(...args)));
      // The record also reads as not yet terminal, so no reader finds the task settled.
      tasks.get = async (id) => {
        const view = await get(id);
        return view !== undefined &&
          !released &&
          (view.status === 'completed' || view.status === 'failed' || view.status === 'canceled')
          ? { ...view, status: 'working' }
          : view;
      };
      try {
        const stream = serverSentEvents(await kit.subscribe(taskId));
        await stream.next();
        await kit.apply(taskId);
        const created = await stream.next();
        expect(revisionsOf(created)).toEqual(['panel@1']);

        await kit.answer(taskId);
        const rest = await drain(stream);
        const states = rest.map((event) => event.data.result.statusUpdate?.status.state);
        expect(states.at(-1)).toBe('TASK_STATE_COMPLETED');
        // The stream ended while the record's settlement was still held back, yet the frozen
        // revision reached the client first.
        expect(rest.filter(isSurfaceFrame).flatMap(revisionsOf)).toEqual(['panel@2']);
      } finally {
        released = true;
        settled.resolve();
        tasks.onSettled = onSettled;
        tasks.get = get;
      }
    });
  });

  it('keeps a surface frame in history order against the status frames around it', async () => {
    await withTask(async (kit) => {
      const taskId = await kit.park();
      const stream = serverSentEvents(await kit.subscribe(taskId));
      await stream.next();
      await kit.apply(taskId);
      await kit.answer(taskId);
      const rest = await drain(stream);
      const order = rest.map((event) =>
        isSurfaceFrame(event)
          ? `surface:${event.data.result.statusUpdate.status.state}`
          : (event.data.result.statusUpdate?.status.state ?? 'artifact'),
      );
      // The surface was made while the task waited, so its frame precedes the run resuming.
      expect(order.indexOf('surface:TASK_STATE_INPUT_REQUIRED')).toBe(0);
      expect(order.indexOf('TASK_STATE_WORKING')).toBeGreaterThan(0);
      expect(order.at(-1)).toBe('TASK_STATE_COMPLETED');
      // The frozen surface is delivered ahead of the terminal status, which closes the stream.
      expect(order.slice(-3)).toEqual([
        'surface:TASK_STATE_WORKING',
        'artifact',
        'TASK_STATE_COMPLETED',
      ]);
      // Cursors never move backwards.
      const cursors = rest.map((event) => event.id).filter((id) => id !== undefined);
      expect(cursors).toEqual([...cursors].toSorted((l, r) => Number(l) - Number(r)));
    });
  });

  it('shows a surface created before the stream opened in its snapshot only', async () => {
    await withTask(async (kit) => {
      const taskId = await kit.park();
      await kit.apply(taskId);
      const stream = serverSentEvents(await kit.subscribe(taskId));
      const opening = await stream.next();
      expect(revisionsOf(opening)).toEqual(['panel@1']);

      await kit.apply(taskId, { baseRevision: 1, text: 'Later' });
      const next = await stream.next();
      expect(revisionsOf(next)).toEqual(['panel@2']);
      await stream.cancel();
    });
  });

  it('resumes from Last-Event-ID without repeating a revision or missing one', async () => {
    await withTask(async (kit) => {
      const taskId = await kit.park();
      const first = serverSentEvents(await kit.subscribe(taskId));
      await first.next();
      await kit.apply(taskId);
      const created = await first.next();
      expect(revisionsOf(created)).toEqual(['panel@1']);
      await first.cancel();

      // Two revisions arrive while the client is away.
      await kit.apply(taskId, { baseRevision: 1, text: 'Two' });
      await kit.apply(taskId, { baseRevision: 2, text: 'Three' });

      const resumed = serverSentEvents(
        await kit.subscribe(taskId, { ...ACTIVATED, 'Last-Event-ID': created?.id ?? '' }),
      );
      const opening = await resumed.next();
      // The snapshot shows the surface as it stands: the revisions missed are not replayed.
      expect(revisionsOf(opening)).toEqual(['panel@3']);

      await kit.apply(taskId, { baseRevision: 3, text: 'Four' });
      const next = await resumed.next();
      expect(revisionsOf(next)).toEqual(['panel@4']);
      await resumed.cancel();
    });
  });

  it('sends deleteSurface for a torn-down surface the client holds, and nothing for one it never held', async () => {
    await withTask(async (kit) => {
      const taskId = await kit.park();
      const stream = serverSentEvents(await kit.subscribe(taskId));
      await stream.next();
      await kit.apply(taskId);
      expect(revisionsOf(await stream.next())).toEqual(['panel@1']);

      await kit.remove(taskId, 'panel', 1);
      const deleted = await stream.next();
      const part = surfaceDataOf(deleted)[0];
      expect(part.data).toEqual([{ version: 'v0.9.1', deleteSurface: { surfaceId: 'panel' } }]);
      expect(part.metadata.surfaceId).toBe('panel');
      await stream.cancel();
    });
  });

  it('declares no catalogs, so a Cinder surface reaches it as its text summary', async () => {
    await withTask(async (kit) => {
      const taskId = await kit.park();
      const stream = serverSentEvents(await kit.subscribe(taskId));
      await stream.next();
      await kit.apply(taskId, { surfaceId: 'cinder', catalog: CINDER });
      const frame = await stream.next();
      expect(surfaceDataOf(frame)).toHaveLength(0);
      expect(frame?.data.result.statusUpdate.status.message.parts).toEqual([{ text: 'A panel' }]);
      await stream.cancel();
    });
  });

  it('sends no surface frame to a client that did not activate A2UI', async () => {
    await withTask(async (kit) => {
      const taskId = await kit.park();
      const stream = serverSentEvents(await kit.subscribe(taskId, PLAIN));
      await stream.next();
      await kit.apply(taskId);
      await kit.apply(taskId, { baseRevision: 1, text: 'Two' });
      await kit.answer(taskId);
      const rest = await drain(stream);
      expect(rest.some(isSurfaceFrame)).toBe(false);
      expect(rest.flatMap(revisionsOf)).toEqual([]);
      expect(rest.at(-1)?.data.result.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
    });
  });
});

describe('SendStreamingMessage with a surface', () => {
  async function opened(kit: Kit, headers: Record<string, string>, extra: Json = {}) {
    const stream = serverSentEvents(await kit.stream(headers, extra));
    let taskId = '';
    for (;;) {
      const event = await stream.next();
      if (event === undefined) throw new Error('the stream ended before INPUT_REQUIRED');
      taskId ||= event.data.result.task?.id ?? '';
      const state =
        event.data.result.task?.status.state ?? event.data.result.statusUpdate?.status.state;
      if (state === 'TASK_STATE_INPUT_REQUIRED') break;
    }
    return { stream, taskId };
  }

  it('sends a surface created during the stream to a client that activated A2UI', async () => {
    await withTask(async (kit) => {
      const { stream, taskId } = await opened(kit, ACTIVATED, {
        metadata: declare([A2UI_BASIC_CATALOG_ID]),
      });
      await kit.apply(taskId);
      const created = await stream.next();
      expect(revisionsOf(created)).toEqual(['panel@1']);
      await kit.apply(taskId, { baseRevision: 1, text: 'Two' });
      expect(revisionsOf(await stream.next())).toEqual(['panel@2']);
      await kit.answer(taskId);
      const rest = await drain(stream);
      expect(rest.flatMap(revisionsOf)).toEqual(['panel@3']);
      expect(rest.at(-1)?.data.result.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
    });
  });

  it('holds each surface to the catalogs the client declared', async () => {
    await withTask(async (kit) => {
      const { stream, taskId } = await opened(kit, ACTIVATED, {
        metadata: declare([A2UI_BASIC_CATALOG_ID, CINDER]),
      });
      await kit.apply(taskId, { surfaceId: 'basic' });
      await kit.apply(taskId, { surfaceId: 'cinder', catalog: CINDER });
      const first = await stream.next();
      const second = await stream.next();
      expect(revisionsOf(first)).toEqual(['basic@1']);
      expect(revisionsOf(second)).toEqual(['cinder@1']);
      await stream.cancel();
    });
    await withTask(async (kit) => {
      const { stream, taskId } = await opened(kit, ACTIVATED, {
        metadata: declare([A2UI_BASIC_CATALOG_ID]),
      });
      await kit.apply(taskId, { surfaceId: 'cinder', catalog: CINDER });
      const frame = await stream.next();
      expect(surfaceDataOf(frame)).toHaveLength(0);
      expect(frame?.data.result.statusUpdate.status.message.parts).toEqual([{ text: 'A panel' }]);
      await stream.cancel();
    });
  });

  it('sends no surface frame to a client that did not activate A2UI', async () => {
    await withTask(async (kit) => {
      const { stream, taskId } = await opened(kit, PLAIN);
      await kit.apply(taskId);
      await kit.answer(taskId);
      const rest = await drain(stream);
      expect(rest.some(isSurfaceFrame)).toBe(false);
      expect(rest.flatMap(revisionsOf)).toEqual([]);
    });
  });
});
