/**
 * A Weft workflow served as an A2A agent, with push notifications.
 *
 * The workflow streams progress to Weft's token feed (which never reaches A2A), waits
 * for an `input` signal, which its A2A task reports as `INPUT_REQUIRED`, sleeps thirty
 * seconds unless it is cancelled, and completes with both values. A client starts it
 * with a text message and answers it with a second message naming the task.
 *
 * It is also the system under test for the official A2A TCK (`test:a2a-tck`), whose
 * scenarios pick an agent's behavior by `messageId` prefix (the TCK's
 * `scenarios/core_operations.feature`). The agent's `input` option hands the workflow
 * each message's `messageId` beside its text, and the example acts on these prefixes:
 *
 * - `tck-complete-task` completes at once, at the start or as an answer.
 * - `tck-artifact-text`, `tck-artifact-file`, `tck-artifact-file-url`, and
 *   `tck-artifact-data` complete at once with that scenario's artifact, which the
 *   agent's `artifacts` option builds from the result.
 * - `tck-message-response` gets a bare agent `Message` from the agent's `respond`
 *   option, and starts no workflow.
 * - `tck-input-required`, as an answer, asks for input again.
 * - Any other answer whose `messageId` starts with `tck-` completes without the sleep,
 *   because the TCK gives each blocking call thirty seconds, which the sleep would race.
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

import type { Artifact, Message, Part } from '@a2a-js/sdk';
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
  resultArtifact,
  startPushDelivery,
  withRedactedPushConfigurations,
} from '@lostgradient/weft/a2a';

import { resolveExampleEnvironment } from './environment-configuration.ts';

export const EXAMPLE_WORKFLOW_TYPE = 'a2a-example-request';
const NAMESPACE = 'a2a-example';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A message as the workflow receives it, at its start and as each answer. */
export type ExampleMessage = { readonly text: string; readonly messageId: string };

/** The TCK artifact scenarios, by `messageId` prefix; `file-url` precedes `file`. */
const ARTIFACT_SCENARIOS = [
  ['tck-artifact-file-url', 'file-url'],
  ['tck-artifact-file', 'file'],
  ['tck-artifact-text', 'text'],
  ['tck-artifact-data', 'data'],
] as const;

export type ArtifactScenario = (typeof ARTIFACT_SCENARIOS)[number][1];

/** What the workflow completes with. */
export type ExampleResult = {
  readonly request: string;
  readonly input?: string;
  /** The TCK artifact scenario the request named, which `artifacts` publishes instead. */
  readonly artifact?: ArtifactScenario;
};

function artifactScenarioOf(messageId: string): ArtifactScenario | undefined {
  return ARTIFACT_SCENARIOS.find(([prefix]) => messageId.startsWith(prefix))?.[1];
}

/** The workflow the example serves. */
export const exampleRequestWorkflow = workflow({
  name: EXAMPLE_WORKFLOW_TYPE,
  description: 'Takes a request, asks for one more input, and answers thirty seconds later.',
  version: '1.0.0',
  tags: ['example'],
}).execute(async function* (ctx: WorkflowContext, request: ExampleMessage) {
  const artifact = artifactScenarioOf(request.messageId);
  if (artifact !== undefined) return { request: request.text, artifact } satisfies ExampleResult;
  if (request.messageId.startsWith('tck-complete-task')) {
    return { request: request.text } satisfies ExampleResult;
  }
  yield* ctx.stream('tokens', async function* () {
    yield `Received the request: ${request.text}`;
    yield 'Waiting for input.';
  });
  let input = yield* ctx.waitForSignal<ExampleMessage>('input');
  while (input.messageId.startsWith('tck-input-required')) {
    input = yield* ctx.waitForSignal<ExampleMessage>('input');
  }
  if (!input.messageId.startsWith('tck-')) yield* ctx.sleep('30s');
  return { request: request.text, input: input.text } satisfies ExampleResult;
});

function part(content: Part['content'], options: Partial<Part> = {}): Part {
  return { content, metadata: undefined, filename: '', mediaType: '', ...options };
}

const SCENARIO_PARTS: Readonly<Record<ArtifactScenario, Part>> = {
  text: part({ $case: 'text', value: 'Generated text content' }),
  file: part(
    { $case: 'raw', value: Buffer.from('tck') },
    { filename: 'output.txt', mediaType: 'text/plain' },
  ),
  'file-url': part(
    { $case: 'url', value: 'https://example.com/output.txt' },
    { filename: 'output.txt', mediaType: 'text/plain' },
  ),
  data: part({ $case: 'data', value: { key: 'value', count: 42 } }),
};

/** The artifact a TCK scenario names, or the agent's default one for any other result. */
export function exampleArtifacts(result: unknown): readonly Artifact[] {
  const scenario = (result as ExampleResult).artifact;
  if (scenario === undefined) return [resultArtifact(result)];
  return [
    {
      artifactId: `tck-${scenario}`,
      name: 'output',
      description: '',
      parts: [SCENARIO_PARTS[scenario]],
      metadata: undefined,
      extensions: [],
    },
  ];
}

/** The bare reply the TCK's `tck-message-response` scenario asks for. */
export function exampleReply(message: Message): readonly Part[] | undefined {
  if (!message.messageId.startsWith('tck-message-response')) return undefined;
  return [part({ $case: 'text', value: 'Direct message response' })];
}

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
    input: (text, message): ExampleMessage => ({
      text: text as string,
      messageId: message.messageId,
    }),
    respond: exampleReply,
    artifacts: exampleArtifacts,
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
