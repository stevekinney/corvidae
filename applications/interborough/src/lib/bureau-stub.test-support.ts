/**
 * A stand-in for the Bureau's management plane, for component tests. It installs a `fetch` that
 * answers `/bureau/jsonrpc` with the handler a test names for each method, in the JSON-RPC
 * envelope the real handler uses, and `/host/paths` with a fixed agent directory. It records every
 * call, so a test can say what was sent. The real Bureau is exercised end to end in the Playwright
 * suite; this is for the component's own branches.
 */
import type { AgentCatalog, AgentDetail, AgentRevision } from './agent-definitions.ts';
import { installFetchImplementation } from './live-source/fetch.test-support.ts';

export type BureauCall = { readonly method: string; readonly params: Record<string, unknown> };

/** A fault a handler throws, answered as the Bureau would: the wire fault code and its payload. */
export class StubFault extends Error {
  readonly weftCode: string;
  readonly httpStatus: number;
  readonly data: Record<string, unknown>;

  constructor(
    weftCode: string,
    httpStatus: number,
    message: string,
    data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'StubFault';
    this.weftCode = weftCode;
    this.httpStatus = httpStatus;
    this.data = data;
  }
}

export type BureauHandler = (params: Record<string, unknown>) => unknown;

/** What a stubbed subscription is opened with: the `Last-Event-ID` a resume names, and the abort signal. */
export type StubSubscriptionRequest = {
  readonly lastEventId: string | undefined;
  readonly signal: AbortSignal | undefined;
};

/** Answers a subscription at `/bureau/v1/subscriptions/<operation>`. */
export type StubSubscriptionHandler = (request: StubSubscriptionRequest) => Response;

/** The directory the stub reports for agent files. */
export const STUB_AGENT_DIRECTORY = '/home/tester/.interborough/agents';
/** The directory the stub reports for workflow files. */
export const STUB_WORKFLOW_DIRECTORY = '/home/tester/.interborough/workflows';

/** The configuration file the stub reports. */
export const STUB_CONFIGURATION_FILE = '/home/tester/.interborough/configuration.json';
/** The directory the stub reports for provider API keys. */
export const STUB_SECRETS_DIRECTORY = '/home/tester/.interborough/secrets';
/** The providers the stub reports, each with the file that holds its API key. */
export const STUB_PROVIDERS: { name: string; secretFile: string }[] = [
  { name: 'anthropic', secretFile: `${STUB_SECRETS_DIRECTORY}/anthropic-api-key` },
  { name: 'openai', secretFile: `${STUB_SECRETS_DIRECTORY}/openai-api-key` },
  { name: 'gemini', secretFile: `${STUB_SECRETS_DIRECTORY}/gemini-api-key` },
];

/** The bucket folder a remote host reports for agent objects. */
export const STUB_REMOTE_AGENT_DIRECTORY = 's3://interborough-state/prod/agents/';
/** The bucket folder a remote host reports for workflow objects. */
export const STUB_REMOTE_WORKFLOW_DIRECTORY = 's3://interborough-state/prod/workflows/';
/** The configuration object a remote host reports. */
export const STUB_REMOTE_CONFIGURATION_FILE = 's3://interborough-state/prod/configuration.json';
/** The providers a remote host reports, each with the variable that holds its API key. */
export const STUB_REMOTE_PROVIDERS: { name: string; secretFile: string }[] = [
  { name: 'anthropic', secretFile: 'INTERBOROUGH_SECRET_ANTHROPIC_API_KEY' },
  { name: 'openai', secretFile: 'INTERBOROUGH_SECRET_OPENAI_API_KEY' },
  { name: 'gemini', secretFile: 'INTERBOROUGH_SECRET_GEMINI_API_KEY' },
];

/** The body `/host/paths` answers with for a host that keeps its state in Postgres and a bucket. */
export function stubRemoteHostPaths() {
  return {
    mode: 'remote' as const,
    database: { kind: 'postgres' as const, location: 'db.example.test:5432/interborough' },
    agentDirectory: STUB_REMOTE_AGENT_DIRECTORY,
    workflowDirectory: STUB_REMOTE_WORKFLOW_DIRECTORY,
    configurationFile: STUB_REMOTE_CONFIGURATION_FILE,
    locked: { configuration: 'deployment' as const, providerKeys: 'deployment' as const },
    providers: STUB_REMOTE_PROVIDERS,
  };
}

/** The body `/host/paths` answers with, for the two directories a test chooses. */
export function stubHostPaths(
  agentDirectory: string,
  workflowDirectory: string,
  mode: 'local' | 'remote' = 'local',
) {
  return {
    mode,
    database:
      mode === 'local'
        ? { kind: 'sqlite' as const, path: '/home/me/.interborough/database.sqlite' }
        : { kind: 'postgres' as const, location: 'db.example.test:5432/interborough' },
    agentDirectory,
    workflowDirectory,
    configurationFile: STUB_CONFIGURATION_FILE,
    locked:
      mode === 'local'
        ? {}
        : { configuration: 'deployment' as const, providerKeys: 'deployment' as const },
    providers: STUB_PROVIDERS,
  };
}

export type BureauStub = {
  readonly calls: BureauCall[];
  /** The calls made to one method, in order. */
  callsTo(method: string): BureauCall[];
  /** Replaces a method's handler, such as to make the next call fail. */
  on(method: string, handler: BureauHandler): void;
  restore(): void;
};

const SUBSCRIPTION_PREFIX = '/bureau/v1/subscriptions/';

/** The URL a `fetch` input names. */
export function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Install the stub. `hostPaths: null` makes `/host/paths` fail, as a host that does not say would.
 * With `passThrough`, a request for anything but the Bureau and the host's paths goes to the
 * `fetch` that was installed before, such as a test that reaches a real engine over the network.
 */
export function installBureauStub(
  handlers: Record<string, BureauHandler>,
  options: {
    readonly hostPaths?: string | null;
    /** `remote` makes `/host/paths` answer as a host that keeps its state in Postgres and a bucket. */
    readonly hostMode?: 'local' | 'remote';
    readonly passThrough?: boolean;
    /** Answers the subscriptions it names, by operation name; any other one is `Not found`. */
    readonly subscriptions?: Readonly<Record<string, StubSubscriptionHandler>>;
  } = {},
): BureauStub {
  const table = new Map(Object.entries(handlers));
  const calls: BureauCall[] = [];
  const before = globalThis.fetch;
  const restoreFetch = installFetchImplementation(async (input, init) => {
    const url = new URL(urlOf(input), 'http://localhost');
    if (
      options.passThrough === true &&
      url.pathname !== '/host/paths' &&
      url.pathname !== '/bureau/jsonrpc'
    ) {
      return before(input, init);
    }
    if (url.pathname === '/host/paths') {
      const directory = options.hostPaths === undefined ? STUB_AGENT_DIRECTORY : options.hostPaths;
      if (directory === null) return new Response('Not found', { status: 404 });
      return Response.json(
        options.hostMode === 'remote'
          ? stubRemoteHostPaths()
          : stubHostPaths(directory, STUB_WORKFLOW_DIRECTORY),
      );
    }
    const subscription = url.pathname.startsWith(SUBSCRIPTION_PREFIX)
      ? options.subscriptions?.[url.pathname.slice(SUBSCRIPTION_PREFIX.length)]
      : undefined;
    if (subscription !== undefined) {
      return subscription({
        lastEventId: new Headers(init?.headers).get('last-event-id') ?? undefined,
        signal: init?.signal ?? undefined,
      });
    }
    if (url.pathname !== '/bureau/jsonrpc' || typeof init?.body !== 'string') {
      return new Response('Not found', { status: 404 });
    }
    const body: unknown = JSON.parse(init.body);
    if (!isRecord(body) || typeof body['method'] !== 'string') {
      return new Response('Bad request', { status: 400 });
    }
    const method = body['method'];
    const params = isRecord(body['params']) ? body['params'] : {};
    calls.push({ method, params });
    const handler = table.get(method);
    if (handler === undefined) {
      return Response.json({ error: `The stub has no handler for ${method}.` }, { status: 500 });
    }
    try {
      return Response.json({ jsonrpc: '2.0', id: body['id'], result: await handler(params) });
    } catch (error) {
      if (!(error instanceof StubFault)) throw error;
      return Response.json({
        jsonrpc: '2.0',
        id: body['id'],
        error: {
          code: -32000,
          message: error.message,
          data: { ...error.data, weftCode: error.weftCode, httpStatus: error.httpStatus },
        },
      });
    }
  });
  return {
    calls,
    callsTo: (method) => calls.filter((call) => call.method === method),
    on: (method, handler) => {
      table.set(method, handler);
    },
    restore: restoreFetch,
  };
}

/** The faults the Bureau's agent operations answer with. */
export const faults = {
  stale: (currentRevision: string, expectedRevision = 'old') =>
    new StubFault('StaleRevision', 409, 'The agent file changed on disk.', {
      currentRevision,
      expectedRevision,
    }),
  notFound: (id: string) => new StubFault('NotFound', 404, `No agent ${id}.`),
  taken: (reason: 'agent-file-exists' | 'shadows-code-agent') =>
    new StubFault('Conflict', 409, 'That identifier is taken.', { reason }),
  unprocessable: (message: string) =>
    new StubFault('Unprocessable', 422, message, { reason: 'unknown-model' }),
};

/**
 * A catalog tool as a test writes it: its name and descriptions. What the tool takes, its tier, its
 * default approval, its source and its users default to a read-only host tool nobody uses.
 */
export type CatalogToolFixture = Pick<
  AgentCatalog['tools'][number],
  'name' | 'description' | 'shortDescription'
> &
  Partial<AgentCatalog['tools'][number]>;

/** The catalog a deployment with one provider offers: two models, one with an alias, and one tool. */
export function catalogFixture(
  overrides: Omit<Partial<AgentCatalog>, 'tools'> & {
    readonly tools?: readonly CatalogToolFixture[];
  } = {},
): AgentCatalog {
  const { tools: overriddenTools, ...rest } = overrides;
  return {
    models: [
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        aliases: [{ alias: 'sonnet', resolvesTo: 'claude-sonnet-5' }],
      },
      { provider: 'anthropic', model: 'claude-haiku-5', aliases: [] },
    ],
    tools: (
      overriddenTools ?? [
        {
          name: 'lookup-order',
          description: 'Look an order up by its identifier.',
          shortDescription: null,
        },
      ]
    ).map((tool) => ({
      inputSchema: { type: 'object' },
      tier: 'read-only' as const,
      defaultApproval: 'allow' as const,
      source: 'host' as const,
      users: [],
      ...tool,
    })),
    ...rest,
  };
}

/** A persisted agent that loaded, as `bureau.agents.definitions.get` shows it. */
export function readyAgent(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id: 'researcher',
    source: 'file',
    state: 'ready',
    name: 'Researcher',
    description: 'Finds and cites sources',
    a2a: false,
    hash: 'hash-1',
    problem: null,
    codeDefinition: null,
    definition: {
      name: 'Researcher',
      description: 'Finds and cites sources',
      model: 'anthropic/sonnet',
      models: null,
      tools: ['lookup-order'],
      skillDescriptors: [
        {
          id: 'cite',
          name: 'Cite',
          description: 'Cites the sources it used',
          tags: ['research'],
        },
      ],
      a2a: false,
      stepLimit: null,
      references: null,
      guardrails: null,
      costBudget: null,
      toolBudget: null,
      toolApproval: null,
      instructions: 'You are a careful researcher.',
    },
    ...overrides,
  };
}

export function revisionFixture(hash: string, lastRunAt: string): AgentRevision {
  return { hash, firstRunAt: lastRunAt, lastRunAt };
}
