/**
 * A Weft workflow served as an A2A agent, with push notifications.
 *
 * The workflow streams progress to Weft's token feed (which never reaches A2A), waits
 * for an `input` signal, which its A2A task reports as `INPUT_REQUIRED`, sleeps thirty
 * seconds unless it is cancelled, and completes with both values. A client starts it
 * with a text message and answers it with a second message naming the task.
 *
 * Push notifications go through an outbox to an egress-checked webhook. The example
 * runs its own loopback receiver, which is on the egress allowlist and logs each
 * notification it receives.
 *
 * Run it with `bun examples/a2a-workflow-agent.ts`. `PORT` (default 7321) and `HOST`
 * (default `127.0.0.1`) choose the listener. `A2A_EXAMPLE_TRUST_LOOPBACK_WEBHOOKS=1`
 * also lets push notifications reach any loopback port over plain HTTP, which a
 * conformance kit's own webhook receiver needs; never set it in a deployment.
 */

import { Engine, MemoryStorage, Outbox, workflow, type WorkflowContext } from '@lostgradient/weft';
import {
  createA2AHandler,
  createEgressPolicy,
  createHttpDeliveryAdapter,
  createOutboxPushNotificationSender,
  createWeftPushNotificationStore,
  createWorkflowAgentExecutor,
  type EgressPolicy,
  pushNotificationResolvers,
  startPushDelivery,
  withRedactedPushConfigurations,
} from '@lostgradient/weft/a2a';

import { resolveExampleEnvironment } from './environment-configuration.ts';

export const EXAMPLE_WORKFLOW_TYPE = 'a2a-example-request';
const NAMESPACE = 'a2a-example';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The workflow the example serves. */
export const exampleRequestWorkflow = workflow({
  name: EXAMPLE_WORKFLOW_TYPE,
  description: 'Takes a request, asks for one more input, and answers thirty seconds later.',
  version: '1.0.0',
  tags: ['example'],
}).execute(async function* (ctx: WorkflowContext, request: string) {
  yield* ctx.stream('tokens', async function* () {
    yield `Received the request: ${request}`;
    yield 'Waiting for input.';
  });
  const input = yield* ctx.waitForSignal<string>('input');
  yield* ctx.sleep('30s');
  return { request, input };
});

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

export type ExampleAgentOptions = {
  readonly port?: number;
  readonly hostname?: string;
  /** Let push notifications reach any loopback port, for a conformance kit's receiver. */
  readonly trustLoopbackWebhooks?: boolean;
  /** Called with each push notification the example's own receiver gets. */
  readonly onNotification?: (body: string) => void;
};

export type ExampleAgent = {
  /** The agent's base URL: its JSON-RPC endpoint and the root of its Agent Card. */
  readonly url: string;
  /** The example's own webhook receiver, on the egress allowlist. */
  readonly receiverUrl: string;
  close(): Promise<void>;
};

/** Start the example agent and its webhook receiver. */
export async function startExampleAgent(options: ExampleAgentOptions = {}): Promise<ExampleAgent> {
  const receiver = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      options.onNotification?.(await request.text());
      return new Response(null, { status: 204 });
    },
  });
  const receiverUrl = `http://127.0.0.1:${receiver.port}/notifications`;

  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(exampleRequestWorkflow);

  const pushStore = createWeftPushNotificationStore({ storage, namespace: NAMESPACE });
  const egressPolicy = createEgressPolicy({
    allowInsecureHttp: true,
    allowlist: [`127.0.0.1:${receiver.port}`],
  });
  const outbox = new Outbox({
    storage,
    namespace: NAMESPACE,
    ownerId: 'push-notifications',
    adapter: createHttpDeliveryAdapter({
      ...pushNotificationResolvers(pushStore),
      egressPolicy: options.trustLoopbackWebhooks ? trustingLoopback(egressPolicy) : egressPolicy,
    }),
  });
  const agent = createWorkflowAgentExecutor({
    engine,
    workflowType: EXAMPLE_WORKFLOW_TYPE,
    inputMode: 'text',
    card: { name: 'Example Request Agent' },
    namespace: NAMESPACE,
    pushNotificationSender: createOutboxPushNotificationSender({ outbox, pushStore }),
  });

  const hostname = options.hostname ?? '127.0.0.1';
  const server = Bun.serve({
    hostname,
    port: options.port ?? 7321,
    idleTimeout: 0,
    fetch: (request) => handler(request),
  });
  const url = `http://${hostname}:${server.port}`;
  const handler = createA2AHandler({
    requestHandler: withRedactedPushConfigurations(agent.requestHandler),
    agentCard: agent.agentCard,
    publicUrl: url,
  });

  const shutdown = new AbortController();
  const delivering = startPushDelivery({ outbox, intervalMs: 250, signal: shutdown.signal });

  return {
    url,
    receiverUrl,
    async close() {
      shutdown.abort();
      await delivering;
      await server.stop(true);
      await receiver.stop(true);
      agent[Symbol.dispose]();
      outbox.dispose();
      await engine[Symbol.asyncDispose]();
    },
  };
}

/**
 * Start the example and report the URL it listens at, and each notification its
 * receiver gets, through `log`.
 */
export async function startExampleAgentAndReport(
  options: Omit<ExampleAgentOptions, 'onNotification'>,
  log: (line: string) => void,
): Promise<ExampleAgent> {
  const agent = await startExampleAgent({
    ...options,
    onNotification: (body) => log(`push notification: ${body}`),
  });
  log(`A2A agent listening at ${agent.url}`);
  return agent;
}

if (import.meta.main) {
  const { port, host, a2aExampleTrustLoopbackWebhooks } = resolveExampleEnvironment();
  const options = {
    port,
    hostname: host ?? '127.0.0.1',
    trustLoopbackWebhooks: a2aExampleTrustLoopbackWebhooks,
  };
  const agent = await startExampleAgentAndReport(options, console.info);
  const stop = (): Promise<never> => agent.close().then(() => process.exit(0));
  process.on('SIGINT', stop).on('SIGTERM', stop);
}
