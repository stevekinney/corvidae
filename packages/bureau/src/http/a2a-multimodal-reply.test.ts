/**
 * COR-788, part 1 — what a Bureau agent's generated media looks like over A2A, requested through
 * the A2A mount: the card's media types come from the agent's backend descriptors; generated media
 * leaves as a file part whose `url` is the asset route (never bytes), a small JSON asset as a data
 * part; a task reads the same parts from a `GetTask`, a stream and its recorded history, and after
 * the run's own detail is gone.
 */
import {
  createAgent,
  createModelCatalog,
  type GenerateFunction,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { base64Of, pngBytes } from '../testing/asset-fixtures.test-support.ts';
import { waitForCondition } from '../test';
import { MAXIMUM_DATA_PART_BYTES } from './a2a-reply-parts.ts';
import { type OpenedBureau, openBureau } from './management/management-fixtures.test-support.ts';

const PUBLIC_URL = 'http://localhost';

// A JSON-RPC body read back from the wire: each test asserts the shape it needs.
type Json = any;

/** A model that takes images in and puts images, documents and files out, as no catalog row does. */
const multimodal = createModelCatalog()
  .descriptors.filter((descriptor) => descriptor.provider === 'anthropic')
  .slice(0, 1)
  .map((descriptor) => ({
    ...descriptor,
    modalities: {
      ...descriptor.modalities,
      image: { ...descriptor.modalities.image, input: true, output: true },
      document: { ...descriptor.modalities.document, output: true },
      file: { ...descriptor.modalities.file, output: true },
    },
  }));

const utf8 = (text: string) => ({
  kind: 'inline' as const,
  data: text,
  encoding: 'utf8' as const,
});

function replying(content: Json[]): GenerateFunction {
  return withBackendDescriptors(
    async () => ({
      content: content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
      parts: content,
      toolCalls: [],
    }),
    multimodal,
  );
}

const textFile = (name: string, text: string) => ({
  type: 'document' as const,
  mimeType: 'text/plain',
  name,
  source: utf8(text),
});

const jsonDocument = (value: unknown, padding = '') => ({
  type: 'document' as const,
  mimeType: 'application/json',
  name: 'result.json',
  source: utf8(JSON.stringify(value) + padding),
});

async function withAgents<T>(
  agents: Record<string, GenerateFunction>,
  body: (opened: OpenedBureau) => Promise<T>,
): Promise<T> {
  const opened = await openBureau({
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, generate]) => [name, createAgent({ name, generate })]),
    ),
    publish: Object.keys(agents),
    handlerOptions: { publicUrl: PUBLIC_URL },
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
): Promise<Response> {
  return opened.handler(
    new Request(`${PUBLIC_URL}/a2a/${agent}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'A2A-Version': '1.0',
        'X-API-Key': 'alice-key',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
}

async function sendTask(opened: OpenedBureau, agent: string, extra: Json = {}): Promise<Json> {
  counter += 1;
  const response = await call(opened, agent, 'SendMessage', {
    message: { messageId: `multimodal-${counter}`, role: 'ROLE_USER', parts: [{ text: 'go' }] },
    ...extra,
  });
  const body: Json = await response.json();
  return body.result?.task ?? body.result ?? body;
}

async function getTask(opened: OpenedBureau, agent: string, id: string): Promise<Json> {
  const response = await call(opened, agent, 'GetTask', { id });
  const body: Json = await response.json();
  return body.result;
}

describe('the Agent Card’s media types', () => {
  it('lists only text for an agent whose model carries no media, and the model’s modalities for one that does', async () => {
    await withAgents(
      {
        plain: async () => ({ content: 'hi', toolCalls: [] }),
        painter: replying([textFile('output.txt', 'hello')]),
      },
      async (opened) => {
        const cards: Record<string, Json> = {};
        for (const name of ['plain', 'painter']) {
          const response = await opened.handler(
            new Request(`${PUBLIC_URL}/a2a/${name}/.well-known/agent-card.json`),
          );
          cards[name] = await response.json();
        }
        expect(cards['plain'].defaultInputModes).toEqual(['text/plain', 'application/json']);
        expect(cards['plain'].defaultOutputModes).toEqual(['text/plain']);
        // The vision model reads images and documents, and a message's file parts are read
        // (COR-788, part 2): the card says so.
        expect(cards['painter'].defaultInputModes).toEqual([
          'text/plain',
          'application/json',
          'image/*',
          'application/pdf',
        ]);
        expect(cards['painter'].defaultOutputModes).toEqual([
          'text/plain',
          'image/*',
          'application/pdf',
          'application/json',
          'application/octet-stream',
        ]);
      },
    );
  });

  it('accepts a client whose acceptedOutputModes names a media family the agent produces, and refuses one it does not', async () => {
    await withAgents(
      {
        plain: async () => ({ content: 'hi', toolCalls: [] }),
        painter: replying([textFile('output.txt', 'hello')]),
      },
      async (opened) => {
        const accepted = { configuration: { acceptedOutputModes: ['image/png'] } };
        const sent = await sendTask(opened, 'painter', accepted);
        expect(sent.status.state).toBe('TASK_STATE_COMPLETED');
        const refused = await sendTask(opened, 'plain', accepted);
        expect(refused.code ?? refused.error?.code).toBe(-32005);
      },
    );
  });
});

describe('a generated file', () => {
  it('leaves as a file part on the asset route in the status message, the artifact and the history, never as bytes', async () => {
    await withAgents(
      { writer: replying([textFile('output.txt', 'Generated text')]) },
      async (opened) => {
        const task = await sendTask(opened, 'writer');

        expect(task.status.state).toBe('TASK_STATE_COMPLETED');
        const [artifact] = task.artifacts;
        expect(artifact.parts).toHaveLength(1);
        const [part] = artifact.parts;
        expect(part).toMatchObject({ filename: 'output.txt', mediaType: 'text/plain' });
        expect(part.url).toMatch(/^http:\/\/localhost\/assets\/[^/]+\/content$/);
        expect(part.raw).toBeUndefined();
        expect(task.status.message.parts).toEqual(artifact.parts);

        // The route serves the bytes, as the caller; they are in no part.
        const content = await opened.handler(
          new Request(part.url, { headers: { 'X-API-Key': 'alice-assets-key' } }),
        );
        expect(content.status).toBe(200);
        expect(await content.text()).toBe('Generated text');
        expect(JSON.stringify(task)).not.toContain(btoa('Generated text'));

        const read = await getTask(opened, 'writer', task.id);
        expect(read.artifacts[0].parts).toEqual(artifact.parts);
        expect(read.history.at(-1).parts).toEqual(artifact.parts);
      },
    );
  });

  it('keeps the asset identity in the task’s history after the run’s own detail is gone', async () => {
    await withAgents(
      { writer: replying([textFile('output.txt', 'Generated text')]) },
      async (opened) => {
        const task = await sendTask(opened, 'writer');
        const url = task.artifacts[0].parts[0].url as string;

        // A restart forgets the live run; the A2A record folded the reply in, and answers alone.
        (opened.bureau as unknown as { getRun: () => undefined }).getRun = () => undefined;
        const read = await getTask(opened, 'writer', task.id);

        expect(read.history.at(-1).parts[0].url).toBe(url);
        expect(read.artifacts[0].parts[0].url).toBe(url);
        expect(read.status.message.parts[0].url).toBe(url);
      },
    );
  });

  it('is the same part on a GetTask, a stream, and every later read (assets are immutable)', async () => {
    await withAgents(
      { writer: replying([textFile('output.txt', 'Generated text')]) },
      async (opened) => {
        counter += 1;
        const streamed = await call(opened, 'writer', 'SendStreamingMessage', {
          message: {
            messageId: `multimodal-${counter}`,
            role: 'ROLE_USER',
            parts: [{ text: 'go' }],
          },
        });
        const text = await streamed.text();
        const events = text
          .split('\n\n')
          .map((block) => block.split('\n').find((line) => line.startsWith('data:')))
          .filter((line): line is string => line !== undefined)
          .map((line) => JSON.parse(line.slice(5)).result);
        const update = events.find((event) => event.artifactUpdate !== undefined);
        expect(update.artifactUpdate.artifact.parts[0]).toMatchObject({
          filename: 'output.txt',
          mediaType: 'text/plain',
        });
        const taskId = update.artifactUpdate.taskId as string;

        const first = await getTask(opened, 'writer', taskId);
        const second = await getTask(opened, 'writer', taskId);
        expect(first.artifacts[0].parts).toEqual(update.artifactUpdate.artifact.parts);
        expect(second.artifacts).toEqual(first.artifacts);
      },
    );
  });
});

describe('a generated JSON document', () => {
  it('is a data part when it is small and parses', async () => {
    await withAgents(
      { reporter: replying([jsonDocument({ key: 'value', count: 42 })]) },
      async (opened) => {
        const task = await sendTask(opened, 'reporter');
        const [part] = task.artifacts[0].parts;
        expect(part.data).toEqual({ key: 'value', count: 42 });
        expect(part.url).toBeUndefined();
        expect(part.mediaType).toBe('application/json');
        const read = await getTask(opened, 'reporter', task.id);
        expect(read.artifacts[0].parts).toEqual([part]);
      },
    );
  });

  it('stays a file part when it is larger than the data-part bound', async () => {
    const padding = ' '.repeat(MAXIMUM_DATA_PART_BYTES);
    await withAgents(
      { reporter: replying([jsonDocument({ key: 'value' }, padding)]) },
      async (opened) => {
        const task = await sendTask(opened, 'reporter');
        const [part] = task.artifacts[0].parts;
        expect(part.data).toBeUndefined();
        expect(part.url).toMatch(/\/assets\/[^/]+\/content$/);
        expect(part.mediaType).toBe('application/json');
      },
    );
  });

  it('stays a file part when its bytes are not JSON, and the task still completes', async () => {
    await withAgents(
      {
        reporter: replying([{ ...jsonDocument({}), source: utf8('{"broken": ') }]),
      },
      async (opened) => {
        const task = await sendTask(opened, 'reporter');
        expect(task.status.state).toBe('TASK_STATE_COMPLETED');
        expect(task.artifacts[0].parts[0].url).toMatch(/\/assets\/[^/]+\/content$/);
      },
    );
  });

  it('stays a file part when the asset cannot be read, and never fails the projection', async () => {
    await withAgents({ reporter: replying([jsonDocument({ ok: true })]) }, async (opened) => {
      const assets = opened.bureau.assets!;
      const inspect = assets.inspect.bind(assets);
      (assets as { inspect: typeof assets.inspect }).inspect = async () => {
        throw new Error('storage fault');
      };
      try {
        const task = await sendTask(opened, 'reporter');
        const read = await getTask(opened, 'reporter', task.id);
        expect(read.status.state).toBe('TASK_STATE_COMPLETED');
        expect(read.artifacts[0].parts).toHaveLength(1);
        expect(read.artifacts[0].parts[0].url).toMatch(/\/assets\/[^/]+\/content$/);
      } finally {
        (assets as { inspect: typeof assets.inspect }).inspect = inspect;
      }
    });
  });

  it('keeps the recorded data part when a later read cannot inspect the asset', async () => {
    await withAgents({ reporter: replying([jsonDocument({ ok: true })]) }, async (opened) => {
      const task = await sendTask(opened, 'reporter');
      await opened.bureau.internals.taskRegistry.idle();
      const first = await getTask(opened, 'reporter', task.id);
      expect(first.artifacts[0].parts[0].data).toEqual({ ok: true });
      const assets = opened.bureau.assets!;
      const inspect = assets.inspect.bind(assets);
      (assets as { inspect: typeof assets.inspect }).inspect = async () => {
        throw new Error('storage fault');
      };
      try {
        const read = await getTask(opened, 'reporter', task.id);
        expect(read.artifacts[0].parts[0].data).toEqual({ ok: true });
        expect(read.artifacts[0].parts[0].url).toBeUndefined();
        expect(read.history.at(-1).parts).toEqual(read.artifacts[0].parts);
      } finally {
        (assets as { inspect: typeof assets.inspect }).inspect = inspect;
      }
    });
  });
});

describe('a reply with text and an image', () => {
  it('keeps the order of its parts and carries each image as a file part with its media type', async () => {
    const image = {
      type: 'image' as const,
      mimeType: 'image/png',
      source: {
        kind: 'inline' as const,
        data: base64Of(pngBytes(4, 3)),
        encoding: 'base64' as const,
      },
    };
    await withAgents(
      { painter: replying([{ type: 'text', text: 'Here it is.' }, image]) },
      async (opened) => {
        const task = await sendTask(opened, 'painter');
        const parts = task.artifacts[0].parts as Json[];
        expect(parts[0]).toEqual({ text: 'Here it is.' });
        expect(parts[1]).toMatchObject({ mediaType: 'image/png' });
        expect(parts[1].url).toMatch(/\/assets\/[^/]+\/content$/);
        expect(JSON.stringify(task)).not.toContain(base64Of(pngBytes(4, 3)));
      },
    );
  });
});

describe('a media task nobody read before a restart', () => {
  /** Sends without waiting, and returns the task's id once the task has settled. */
  async function settledWithoutRead(opened: OpenedBureau, agent: string): Promise<string> {
    counter += 1;
    const response = await call(opened, agent, 'SendMessage', {
      message: { messageId: `multimodal-${counter}`, role: 'ROLE_USER', parts: [{ text: 'go' }] },
      configuration: { returnImmediately: true },
    });
    const body: Json = await response.json();
    const id = (body.result?.task ?? body.result).id as string;
    let status: string | undefined;
    await waitForCondition(() => {
      void opened.bureau.internals.taskRegistry.get(id).then((view) => {
        status = view?.status;
      });
      return status === 'completed';
    }, 'settled');
    await opened.bureau.internals.taskRegistry.idle();
    return id;
  }

  /** The Bureau as a restarted process sees it: no live run, and (optionally) no event history. */
  function restarted(opened: OpenedBureau, options: { history: boolean }): void {
    const bureau = opened.bureau as unknown as Record<string, unknown>;
    bureau['getRun'] = () => undefined;
    if (!options.history) {
      bureau['eventHistory'] = async () => ({ outcome: 'unsupported-capability' });
    }
  }

  it('answers from the record folded when the task settled, with no run and no history left', async () => {
    await withAgents(
      {
        writer: replying([
          { type: 'text', text: 'Done.' },
          textFile('output.txt', 'Generated text'),
          jsonDocument({ key: 'value' }),
        ]),
      },
      async (opened) => {
        const id = await settledWithoutRead(opened, 'writer');
        restarted(opened, { history: false });

        const read = await getTask(opened, 'writer', id);

        expect(read.artifacts[0].parts[0]).toEqual({ text: 'Done.' });
        expect(read.artifacts[0].parts[1]).toMatchObject({
          filename: 'output.txt',
          mediaType: 'text/plain',
        });
        expect(read.artifacts[0].parts[1].url).toMatch(/\/assets\/[^/]+\/content$/);
        expect(read.artifacts[0].parts[2].data).toEqual({ key: 'value' });
        expect(read.history.at(-1).parts).toEqual(read.artifacts[0].parts);
      },
    );
  });

  it('rebuilds the parts from the run’s durable completion when the record holds no reply', async () => {
    const opened = await openBureau({
      agents: {
        writer: createAgent({
          name: 'writer',
          generate: replying([textFile('output.txt', 'Generated text')]),
        }),
      },
      publish: ['writer'],
      durableHistory: true,
      handlerOptions: { publicUrl: PUBLIC_URL },
    });
    try {
      // This process never records the reply when the task settles; a later read must find it.
      (
        opened.bureau.internals.taskRegistry as unknown as { onSettled: () => () => void }
      ).onSettled = () => () => undefined;
      const id = await settledWithoutRead(opened, 'writer');
      restarted(opened, { history: true });

      const read = await getTask(opened, 'writer', id);

      expect(read.artifacts[0].parts[0]).toMatchObject({ filename: 'output.txt' });
      expect(read.artifacts[0].parts[0].url).toMatch(/\/assets\/[^/]+\/content$/);
      expect(read.status.message.parts).toEqual(read.artifacts[0].parts);
    } finally {
      await opened.dispose();
    }
  });
});

describe('the text bound on a reply', () => {
  const limit = 64 * 1024;
  const longText = 'x'.repeat(limit + 5000);
  const image = {
    type: 'image' as const,
    mimeType: 'image/png',
    source: {
      kind: 'inline' as const,
      data: base64Of(pngBytes(4, 3)),
      encoding: 'base64' as const,
    },
  };

  async function streamedParts(opened: OpenedBureau, agent: string): Promise<Json[]> {
    counter += 1;
    const streamed = await call(opened, agent, 'SendStreamingMessage', {
      message: { messageId: `multimodal-${counter}`, role: 'ROLE_USER', parts: [{ text: 'go' }] },
    });
    const raw = await streamed.text();
    const events = raw
      .split('\n\n')
      .map((block) => block.split('\n').find((line) => line.startsWith('data:')))
      .filter((line): line is string => line !== undefined)
      .map((line) => JSON.parse(line.slice(5)).result);
    const update = events.find((event) => event.artifactUpdate !== undefined);
    const status = events.find((event) => event.statusUpdate?.status?.message !== undefined);
    expect(status.statusUpdate.status.message.parts).toEqual(update.artifactUpdate.artifact.parts);
    return update.artifactUpdate.artifact.parts;
  }

  const textLength = (parts: Json[]) =>
    parts.reduce((total, part) => total + (part.text?.length ?? 0), 0);

  it('bounds the text of a reply that also holds media, on a read and on a stream alike', async () => {
    await withAgents(
      { painter: replying([{ type: 'text', text: longText }, image]) },
      async (opened) => {
        const parts = await streamedParts(opened, 'painter');
        expect(textLength(parts)).toBeLessThanOrEqual(limit);
        expect(parts.some((part) => part.mediaType === 'image/png')).toBe(true);
        const task = await sendTask(opened, 'painter');
        expect(textLength(task.artifacts[0].parts)).toBeLessThanOrEqual(limit);
        expect(task.artifacts[0].parts.some((part: Json) => part.mediaType === 'image/png')).toBe(
          true,
        );
      },
    );
  });

  it('streams the same bounded parts that a read returns for a text-only reply', async () => {
    await withAgents({ writer: replying([{ type: 'text', text: longText }]) }, async (opened) => {
      const parts = await streamedParts(opened, 'writer');
      expect(textLength(parts)).toBeLessThanOrEqual(limit);
      const task = await sendTask(opened, 'writer');
      expect(textLength(task.artifacts[0].parts)).toBeLessThanOrEqual(limit);
    });
  });
});

describe('the settlement fold', () => {
  it('leaves no settled listener behind for a task that has settled', async () => {
    await withAgents({ writer: replying([{ type: 'text', text: 'Done.' }]) }, async (opened) => {
      const tasks = opened.bureau.internals.taskRegistry as unknown as {
        onSettled: (taskId: string, listener: never) => () => void;
      };
      const original = tasks.onSettled.bind(tasks);
      let held = 0;
      tasks.onSettled = (taskId, listener) => {
        held += 1;
        const stop = original(taskId, listener);
        let released = false;
        return () => {
          if (!released) held -= 1;
          released = true;
          stop();
        };
      };
      await sendTask(opened, 'writer');
      await opened.bureau.internals.taskRegistry.idle();
      expect(held).toBe(0);
    });
  });

  it('is awaited by the registry’s idle, which a shutdown runs before storage closes', async () => {
    await withAgents({ painter: replying([jsonDocument({ ok: true })]) }, async (opened) => {
      const assets = opened.bureau.assets!;
      const inspect = assets.inspect.bind(assets);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached = false;
      (assets as { inspect: typeof assets.inspect }).inspect = async (...args) => {
        reached = true;
        await gate;
        return inspect(...args);
      };
      counter += 1;
      const response = await call(opened, 'painter', 'SendMessage', {
        message: { messageId: `multimodal-${counter}`, role: 'ROLE_USER', parts: [{ text: 'go' }] },
        configuration: { returnImmediately: true },
      });
      const body: Json = await response.json();
      const id = (body.result?.task ?? body.result).id as string;
      await waitForCondition(() => reached, 'the fold reading the asset');
      let drained = false;
      const idle = opened.bureau.internals.taskRegistry.idle().then(() => {
        drained = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(drained).toBe(false);
      release();
      await idle;
      (assets as { inspect: typeof assets.inspect }).inspect = inspect;
      const read = await getTask(opened, 'painter', id);
      expect(read.history.at(-1).parts[0].data).toEqual({ ok: true });
    });
  });
});
