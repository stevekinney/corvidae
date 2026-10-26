/**
 * The Bureau system under test for the official A2A Technology Compatibility Kit (COR-1543): one
 * published agent, `tck-agent`, served at `<publicUrl>/a2a/tck-agent` over a Bureau with a
 * durable event history and push delivery.
 *
 * The TCK picks an agent's behavior by the prefix of a message's `messageId` (its
 * `scenarios/*.feature`). A Bureau agent sees only a message's text, so the host rewrites each
 * sent message on its way in: the text becomes `[<messageId>] <text>`, and the agent's scripted
 * generator reads the bracketed identifier. Each send also gets a unique `messageId` suffix; see
 * {@link effectiveMessageId}. The agent answers at once, asks for input
 * (`INPUT_REQUIRED`) for `tck-input-required`, answers with a generated file or a JSON document for
 * the file and data artifact scenarios (COR-788), and sleeps until it is cancelled or the long wait
 * ends for the resubscription scenario.
 *
 * The host serves with `unauthenticatedAccess: 'allow'` (test only), because the pinned TCK
 * documents no way to send credentials, so its tasks belong to the `anonymous:local` owner. Push
 * notifications may reach any loopback port over plain HTTP, because the TCK's own webhook
 * receiver picks its port. Never serve a deployment this way.
 *
 * The host prints `A2A_TCK_SUT_URL=<url>` as its only stdout line once it listens; everything else
 * goes to stderr. The first argument (default: any free port) chooses the listener. It stops on SIGTERM.
 *
 * Run it through `bun run --filter=@lostgradient/bureau test:a2a-tck`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgent,
  createModelCatalog,
  type GenerateFunction,
  type GenerateResponse,
  stopWhen,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { MemoryStorage, Outbox } from '@lostgradient/weft';
import {
  createEgressPolicy,
  createHttpDeliveryAdapter,
  createOutboxPushNotificationSender,
  createWeftPushNotificationStore,
  type EgressPolicy,
  pushNotificationResolvers,
  startPushDelivery,
} from '@lostgradient/weft/a2a';

import { createMemoryAssetStorage } from '../src/assets/storage.ts';
import { createBureau } from '../src/create-bureau.ts';
import { createBureauHandler } from '../src/http/create-bureau-handler.ts';

export const TCK_AGENT = 'tck-agent';
const NAMESPACE = 'a2a-tck';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MESSAGE_MARKER = /\[((?:tck|test)-[^\]]+)\]/;

/** How long the resubscription scenario's task runs before it completes. */
const LONG_RUNNING_MS = 8_000;

/** Lets every loopback URL through over plain HTTP, and defers anything else to `policy`. */
function trustingLoopback(policy: EgressPolicy): EgressPolicy {
  return {
    async check(url) {
      const parsed = new URL(url);
      if (LOOPBACK_HOSTS.has(parsed.hostname)) return { status: 'allowed', url: parsed };
      return policy.check(url);
    },
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

/** A model that puts documents out, which no catalog row does: the file and data scenarios need one. */
const documentOutputDescriptors = createModelCatalog()
  .descriptors.filter((descriptor) => descriptor.provider === 'anthropic')
  .slice(0, 1)
  .map((descriptor) => ({
    ...descriptor,
    modalities: {
      ...descriptor.modalities,
      document: { ...descriptor.modalities.document, output: true },
    },
  }));

const utf8 = (data: string) => ({ kind: 'inline', data, encoding: 'utf8' }) as const;

/** A response of generated media only; the run admits each part as a managed asset. */
function generated(parts: GenerateResponse['parts']): GenerateResponse {
  return { content: '', parts, toolCalls: [] };
}

/** The agent's scripted behavior, picked by the `messageId` the host stamped on the message. */
export const scriptedGenerate: GenerateFunction = async ({ conversation, signal }) => {
  const messages = conversation.getMessages();
  // The scenario is the latest user message's: the first message, or the last answer to a wait,
  // which the conversation holds as a user message too.
  const latest = messages.findLast((message) => message.role === 'user');
  const waits = messages.filter((message) => message.role === 'tool-call').length;
  const scenario = MESSAGE_MARKER.exec(textOf(latest?.content))?.[1] ?? '';
  // `tck-input-required`, as the first message or as an answer, waits for input again.
  if (scenario.startsWith('tck-input-required')) {
    return {
      content: '',
      toolCalls: [
        {
          id: `wait-${waits + 1}`,
          name: 'requestHumanInput',
          arguments: { signalName: 'human-response', prompt: 'More input, please.' },
        },
      ],
    };
  }
  // The file scenarios answer with a generated file and no text, so the file is the task's first
  // artifact part. `tck-artifact-file-url` is checked first: its prefix is `tck-artifact-file`'s.
  // Bureau serves the file from its asset route, so the part is a URL either way.
  if (scenario.startsWith('tck-artifact-file')) {
    return generated([
      {
        type: 'document',
        mimeType: 'text/plain',
        name: 'output.txt',
        source: utf8('Generated file'),
      },
    ]);
  }
  if (scenario.startsWith('tck-artifact-data')) {
    return generated([
      {
        type: 'document',
        mimeType: 'application/json',
        source: utf8(JSON.stringify({ key: 'value', count: 42 })),
      },
    ]);
  }
  if (scenario.startsWith('tck-artifact-text')) {
    return { content: 'Generated text content', toolCalls: [] };
  }
  if (scenario.startsWith('tck-stream-artifact-text')) {
    return { content: 'Streamed text content', toolCalls: [] };
  }
  if (scenario.startsWith('test-resubscribe') || scenario.startsWith('tck-sleep')) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, LONG_RUNNING_MS);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('The task was cancelled while it slept.'));
        },
        { once: true },
      );
    });
  }
  return { content: 'Hello from TCK', toolCalls: [] };
};

/**
 * The TCK gives every scenario's messages one `messageId` per session (`tck-input-required-<id>`)
 * and expects each send to start a fresh task, whether a later test sends the same text or
 * different text under it. Bureau binds a `messageId` to the task it created, so an exact retry
 * finds that task again and a different payload is refused, as a retry-safe command must. The
 * host therefore makes every request its own command: it suffixes the identifier with a counter
 * (`-r1`, `-r2`), which keeps the prefix the scenario is picked by.
 */
let sends = 0;

function effectiveMessageId(messageId: string): string {
  sends += 1;
  return `${messageId}-r${sends}`;
}

/** The same POST with `body` in place of the one already read. */
function repost(request: Request, body: string): Request {
  return new Request(request.url, { method: 'POST', headers: request.headers, body });
}

/** Stamps each sent message's `messageId` into its first text part. */
async function stampMessageId(request: Request): Promise<Request> {
  if (request.method !== 'POST') return request;
  const text = await request.text();
  try {
    const body = JSON.parse(text) as {
      method?: string;
      params?: { message?: { messageId?: string; parts?: Array<{ text?: string }> } };
    };
    const message = body.params?.message;
    const part = message?.parts?.find((entry) => typeof entry.text === 'string');
    if (
      (body.method === 'SendMessage' || body.method === 'SendStreamingMessage') &&
      message?.messageId !== undefined &&
      part !== undefined
    ) {
      message.messageId = effectiveMessageId(message.messageId);
      part.text = `[${message.messageId}] ${part.text}`;
      return repost(request, JSON.stringify(body));
    }
  } catch {
    // Not JSON: the handler answers it.
  }
  return repost(request, text);
}

export type TckHost = {
  /** `<publicUrl>/a2a/tck-agent`. */
  readonly url: string;
  stop(): Promise<void>;
};

/** Starts the host on `port` (any free port by default). */
export async function startTckHost(port = 0): Promise<TckHost> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-a2a-tck-'));
  const bureau = await createBureau({
    id: 'a2a-tck-bureau',
    agents: {
      [TCK_AGENT]: createAgent({
        name: TCK_AGENT,
        generate: withBackendDescriptors(scriptedGenerate, documentOutputDescriptors),
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      }),
    },
    storage: { type: 'sqlite', path: join(directory, 'bureau.sqlite') },
    durableExecution: true,
    assets: { storage: createMemoryAssetStorage() },
  });

  const pushStorage = new MemoryStorage();
  const pushStore = createWeftPushNotificationStore({ storage: pushStorage, namespace: NAMESPACE });
  const outbox = new Outbox({
    storage: pushStorage,
    namespace: NAMESPACE,
    ownerId: 'push-notifications',
    adapter: createHttpDeliveryAdapter({
      ...pushNotificationResolvers(pushStore),
      egressPolicy: trustingLoopback(createEgressPolicy({ allowInsecureHttp: true })),
    }),
  });
  const sender = createOutboxPushNotificationSender({ outbox, pushStore });

  let handler: ((request: Request) => Promise<Response>) | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    idleTimeout: 0,
    fetch: async (request) =>
      (handler as NonNullable<typeof handler>)(await stampMessageId(request)),
  });
  const publicUrl = `http://127.0.0.1:${server.port}`;
  handler = createBureauHandler(bureau, {
    unauthenticatedAccess: 'allow',
    publish: [TCK_AGENT],
    publicUrl,
    pushNotifications: { sender, outbox },
  });

  const shutdown = new AbortController();
  const delivering = startPushDelivery({
    outbox,
    intervalMs: 100,
    signal: shutdown.signal,
    onError: (error) => console.error('push delivery failed:', error),
  });

  return {
    url: `${publicUrl}/a2a/${TCK_AGENT}`,
    async stop() {
      shutdown.abort();
      await delivering;
      await server.stop(true);
      outbox.dispose();
      pushStorage[Symbol.dispose]();
      await bureau.shutdown({ policy: 'abort' });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

if (import.meta.main) {
  const host = await startTckHost(Number(Bun.argv[2] ?? 0));
  // The runner reads the agent's URL from this one stdout line.
  process.stdout.write(`A2A_TCK_SUT_URL=${host.url}\n`);
  console.error(`A2A TCK host listening at ${host.url}`);
  const stop = () => void host.stop().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
