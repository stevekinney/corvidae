/**
 * Saved tool sources: build the tools of an MCP server or an OpenAPI service from a plain-JSON
 * description plus an injected credential resolver.
 *
 * A host persists {@link ToolSourceDescription}s (no functions, no secrets) and calls
 * {@link loadToolSource} at boot. A credential appears in a description only as the name of a
 * credential the host stores; its value reaches the loader solely through
 * {@link LoadToolSourceOptions.resolveCredential}, and the loader reads no environment variable,
 * file, or other store. OAuth state for an MCP source persists through the injected
 * {@link McpOAuthTokenStorage}.
 *
 * Parsing is strict, so a host that needs its own fields on a saved source (a per-tool
 * `acceptsSecrets`, say) keeps them in a record beside the description, keyed by its `id`, and
 * never spreads them into it.
 */
import type { Client, OAuthClientMetadata } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';

import type { Tool } from '../../is-tool';
import {
  completeMcpOAuthAuthorization,
  connectMcpClient,
  connectMcpClientWithOAuth,
  createMcpOAuthProvider,
  fromMcpClientTools,
  isMcpUnauthorizedError,
  type McpOAuthTokenStorage,
} from '../mcp/oauth';
import { createToolboxFromOpenAPI, type OpenAPIAuth, type OpenAPISpec } from '../openapi';
import { mcpRecipient, versionOfMaterial } from './tool-version';

const nonEmptyString = z.string().min(1);

/**
 * A URL a description may hold: http or https, with no userinfo, so a credential written as
 * `user:password@host` can never be saved in a description.
 */
const httpUrl = z
  .url({ protocol: /^https?$/ })
  .refine((value) => !hasUserinfo(value), 'a URL must not contain a username or password');

function hasUserinfo(value: string): boolean {
  // A refinement also runs on a value the URL check already rejected.
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.username !== '' || url.password !== '';
}

/** The name a saved description uses for a credential the host stores; never the secret itself. */
const credentialName = nonEmptyString;

/** Authentication for an MCP server reached over HTTP: a bearer token, or an OAuth flow. */
const mcpHttpAuthenticationSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('bearer'), credential: credentialName }),
  z.strictObject({
    type: z.literal('oauth'),
    /** The OAuth scope to request, when the server needs one. */
    scope: nonEmptyString.optional(),
    /** The `client_name` to register with the authorization server. */
    clientName: nonEmptyString.optional(),
  }),
]);

/** How to reach an MCP server: a URL, or a local command spoken to over stdio. */
const mcpTransportSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('http'),
    url: httpUrl,
    authentication: mcpHttpAuthenticationSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('stdio'),
    command: nonEmptyString,
    args: z.array(z.string()).optional(),
    cwd: nonEmptyString.optional(),
    /** Plain, non-secret environment variables for the child process. */
    env: z.record(z.string(), z.string()).optional(),
    /** Environment variable name to the name of the credential whose value fills it. */
    credentialEnv: z.record(nonEmptyString, credentialName).optional(),
  }),
]);

/** A saved MCP tool source. */
const mcpToolSourceSchema = z.strictObject({
  id: nonEmptyString,
  kind: z.literal('mcp'),
  transport: mcpTransportSchema,
});

/** Where an OpenAPI source reads its document: fetched from a URL, or embedded as JSON. */
const openApiSpecificationSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('url'), url: httpUrl }),
  z.strictObject({
    type: z.literal('document'),
    document: z.custom<OpenAPISpec>(
      (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
      'an OpenAPI document must be a JSON object',
    ),
  }),
]);

/** Authentication for an OpenAPI service: a bearer token, or an API key sent in a header. */
const openApiAuthenticationSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('bearer'), credential: credentialName }),
  z.strictObject({
    type: z.literal('api-key'),
    header: nonEmptyString,
    credential: credentialName,
  }),
]);

/** A saved OpenAPI tool source. */
const openApiToolSourceSchema = z.strictObject({
  id: nonEmptyString,
  kind: z.literal('openapi'),
  specification: openApiSpecificationSchema,
  /** Defaults to the document's `servers[0].url`. */
  baseUrl: httpUrl.optional(),
  authentication: openApiAuthenticationSchema.optional(),
  /** Restricts the generated tools to these `operationId`s. */
  allowOperations: z.array(nonEmptyString).optional(),
  /** Prefix applied to every generated tool name. */
  namePrefix: z.string().optional(),
});

/** The schema every saved tool source description satisfies. */
export const toolSourceDescriptionSchema = z.discriminatedUnion('kind', [
  mcpToolSourceSchema,
  openApiToolSourceSchema,
]);

/** A saved MCP tool source: plain JSON, with credentials referenced by name. */
export type McpToolSourceDescription = z.infer<typeof mcpToolSourceSchema>;

/** A saved OpenAPI tool source: plain JSON, with credentials referenced by name. */
export type OpenApiToolSourceDescription = z.infer<typeof openApiToolSourceSchema>;

/** A saved tool source: serializable as JSON, holding no secret and no function. */
export type ToolSourceDescription = z.infer<typeof toolSourceDescriptionSchema>;

/**
 * Validates a value read back from persisted configuration and returns it as a
 * {@link ToolSourceDescription}. Unknown fields are rejected, so a typo cannot silently drop a
 * restriction.
 *
 * @throws {ToolSourceDescriptionError} when the value is not a valid description.
 */
export function parseToolSourceDescription(value: unknown): ToolSourceDescription {
  const result = toolSourceDescriptionSchema.safeParse(value);
  if (!result.success) {
    throw new ToolSourceDescriptionError(z.prettifyError(result.error));
  }
  return result.data;
}

/** Thrown when a value is not a valid {@link ToolSourceDescription}. */
export class ToolSourceDescriptionError extends Error {
  constructor(message: string) {
    super(`Invalid tool source description: ${message}`);
    this.name = 'ToolSourceDescriptionError';
  }
}

/** Thrown when an OpenAPI source has no usable absolute http(s) base URL to send requests to. */
export class ToolSourceBaseUrlError extends Error {
  constructor(
    /** The source whose base URL could not be resolved. */
    readonly sourceId: string,
    reason: string,
  ) {
    super(`Tool source "${sourceId}": ${reason}`);
    this.name = 'ToolSourceBaseUrlError';
  }
}

/** Which credential of which source the loader is asking the host for. */
export type ToolSourceCredentialRequest = {
  /** The `id` of the source that needs the credential. */
  sourceId: string;
  /** The credential name the description carries. */
  credential: string;
};

/**
 * Supplies a credential's value for a source. Return `undefined` when the host has none; the
 * loader then fails with a {@link ToolSourceCredentialError}. This is the only way a credential
 * reaches the loader.
 */
export type ToolSourceCredentialResolver = (
  request: ToolSourceCredentialRequest,
) => string | undefined | Promise<string | undefined>;

/** Thrown when the credential resolver has no value for a credential a source names. */
export class ToolSourceCredentialError extends Error {
  constructor(
    /** The source that asked for the credential. */
    readonly sourceId: string,
    /** The credential name that had no value. */
    readonly credential: string,
  ) {
    super(`Tool source "${sourceId}" needs credential "${credential}", which was not available.`);
    this.name = 'ToolSourceCredentialError';
  }
}

/**
 * Thrown when an MCP source needs its user to authorize first. The authorization URL was already
 * passed to {@link ToolSourceOAuthOptions.onAuthorizationRequired}; complete the flow with
 * `completeMcpOAuthAuthorization` and load the source again.
 */
export class ToolSourceAuthorizationRequiredError extends Error {
  constructor(
    /** The source that needs authorization. */
    readonly sourceId: string,
    options?: { cause?: unknown },
  ) {
    super(`Tool source "${sourceId}" needs authorization before its tools can be loaded.`, options);
    this.name = 'ToolSourceAuthorizationRequiredError';
  }
}

/** Host-owned pieces of the MCP OAuth flow, which a persisted description cannot carry. */
export type ToolSourceOAuthOptions = {
  /** Where one source's tokens, client registration, and PKCE state live. */
  tokenStorage: (sourceId: string) => McpOAuthTokenStorage;
  /** The redirect URI registered with the authorization server for one source. */
  redirectUrl: (sourceId: string) => string | URL;
  /** Receives the URL the user must visit; this module opens no browser. */
  onAuthorizationRequired: (sourceId: string, authorizationUrl: URL) => void | Promise<void>;
};

/** Everything {@link loadToolSource} takes besides the description. */
export type LoadToolSourceOptions = {
  /** The only way a credential value reaches the loader. */
  resolveCredential: ToolSourceCredentialResolver;
  /** Required by an MCP source that authenticates with `oauth`. */
  oauth?: ToolSourceOAuthOptions;
  /** Fetch for the OpenAPI document, OpenAPI calls, and MCP over HTTP. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Abandons the load when it aborts before the load settles: an MCP source stops the child
   * process or connection it opened (a stdio server that never answers is killed, not waited on
   * for the SDK's own timeout), and the load rejects. Aborting after the load has settled does
   * nothing; close the returned source instead. An OpenAPI source and an OAuth connection hold
   * no process and are not closed by it.
   */
  signal?: AbortSignal;
};

/** The tools a saved source produced, and the connection to release when the host shuts down. */
export type LoadedToolSource = {
  /** The `id` of the description this was loaded from. */
  id: string;
  /** Which integration produced the tools. */
  kind: ToolSourceDescription['kind'];
  /** The tools the source produced, ready to register in a toolbox. */
  tools: readonly Tool[];
  /** Releases the connection: closes an MCP client and stops a stdio child. Idempotent. */
  close(): Promise<void>;
};

/**
 * Builds the tools for one saved source.
 *
 * An MCP source connects and lists its server's tools, mapped to capability tiers from the
 * server's annotations (`readOnlyHint` read-only, `destructiveHint` dangerous, everything else
 * mutating). An OpenAPI source generates one tool per operation, tiered by HTTP method. The
 * description is validated first.
 *
 * Every tool carries a `version` (COR-1950), a digest of what a person approves: the source's
 * `id`, where its calls go, the tool's name and input schema, and its capability (an MCP tool's
 * annotations, an OpenAPI operation's method and path). Armorer binds an approval to the tool's
 * id, which includes the version, and refuses to issue one for a tool with none, so a changed
 * tool needs a new approval and an earlier one no longer applies. An unchanged tool has the same
 * version at every start. See `tool-version.ts` for what the digest leaves out.
 *
 * @throws {ToolSourceDescriptionError} for an invalid description.
 * @throws {ToolSourceCredentialError} when a named credential has no value.
 * @throws {ToolSourceAuthorizationRequiredError} when an OAuth source needs the user to authorize.
 */
export async function loadToolSource(
  description: ToolSourceDescription,
  options: LoadToolSourceOptions,
): Promise<LoadedToolSource> {
  // The options object is caller-owned and read after awaits below, so it is copied first.
  const source = parseToolSourceDescription(description);
  const snapshot = { ...options };
  snapshot.signal?.throwIfAborted();
  return source.kind === 'mcp'
    ? loadMcpSource(source, snapshot)
    : loadOpenApiSource(source, snapshot);
}

/** A source that failed to load, kept apart so one bad source does not hide the rest. */
export type ToolSourceLoadFailure = {
  /** The `id` of the description that failed. */
  id: string;
  /** What the load threw. */
  error: unknown;
};

/** What {@link loadToolSources} returns. */
export type LoadedToolSources = {
  /** The sources that loaded, in the order of the descriptions that succeeded. */
  sources: LoadedToolSource[];
  /** The sources that did not, with the error each threw. */
  failures: ToolSourceLoadFailure[];
};

/**
 * Loads many saved sources concurrently. A source that fails is reported in `failures` and the
 * rest still load, so one unreachable server does not stop a host from booting.
 */
export async function loadToolSources(
  descriptions: readonly ToolSourceDescription[],
  options: LoadToolSourceOptions,
): Promise<LoadedToolSources> {
  const list = [...descriptions];
  const settled = await Promise.allSettled(
    list.map((description) => loadToolSource(description, options)),
  );
  const sources: LoadedToolSource[] = [];
  const failures: ToolSourceLoadFailure[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      sources.push(outcome.value);
    } else {
      failures.push({ id: list[index]?.id ?? '', error: outcome.reason });
    }
  });
  return { sources, failures };
}

async function requireCredential(
  sourceId: string,
  credential: string,
  options: LoadToolSourceOptions,
): Promise<string> {
  const value = await options.resolveCredential({ sourceId, credential });
  if (value === undefined || value === '') {
    throw new ToolSourceCredentialError(sourceId, credential);
  }
  return value;
}

async function loadMcpSource(
  source: McpToolSourceDescription,
  options: LoadToolSourceOptions,
): Promise<LoadedToolSource> {
  const client =
    source.transport.type === 'stdio'
      ? await connectStdio(source.id, source.transport, options)
      : await connectHttp(source.id, source.transport, options);
  // Listing the tools is a request of its own, and may hang as the handshake may.
  const stopWatching = closeOnAbort(options.signal, () => client.close());
  try {
    const recipient = mcpRecipient(source.transport);
    const tools = await fromMcpClientTools(client, {
      serverId: source.id,
      // What a person approves of the tool (see `tool-version.ts`): an approval is bound to it.
      version: (tool, capability) =>
        versionOfMaterial(['mcp', source.id, recipient, tool.name, tool.inputSchema, capability]),
    });
    return { id: source.id, kind: 'mcp', tools, close: onceAsync(() => client.close()) };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  } finally {
    stopWatching();
  }
}

/**
 * Runs `close` when `signal` aborts, and returns the function that stops watching. A signal that
 * has already aborted runs it at once.
 */
function closeOnAbort(signal: AbortSignal | undefined, close: () => Promise<unknown>): () => void {
  if (signal === undefined) return () => undefined;
  const run = (): void => void close().catch(() => undefined);
  if (signal.aborted) {
    run();
    return () => undefined;
  }
  signal.addEventListener('abort', run, { once: true });
  return () => signal.removeEventListener('abort', run);
}

/**
 * {@link connectMcpClient} over `transport`, closing the transport if `signal` aborts first. For
 * the SDK's stdio transport that kills the child, including the throwaway sibling it probes the
 * server's protocol version on, which a pending connect would otherwise wait on for a minute.
 */
async function connectUntilAborted(
  transport: Parameters<typeof connectMcpClient>[0],
  signal: AbortSignal | undefined,
): Promise<Client> {
  signal?.throwIfAborted();
  const stopWatching = closeOnAbort(signal, () => transport.close());
  try {
    return await connectMcpClient(transport);
  } finally {
    stopWatching();
  }
}

async function connectHttp(
  sourceId: string,
  transport: Extract<McpToolSourceDescription['transport'], { type: 'http' }>,
  options: LoadToolSourceOptions,
): Promise<Client> {
  const fetchOption = options.fetch ? { fetch: options.fetch } : {};
  const authentication = transport.authentication;
  if (authentication?.type === 'oauth') {
    const oauth = options.oauth;
    if (!oauth) {
      throw new Error(
        `Tool source "${sourceId}" authenticates with OAuth, but no \`oauth\` options were given to the loader.`,
      );
    }
    const provider = createToolSourceOAuthProvider(sourceId, authentication, oauth);
    try {
      return await connectMcpClientWithOAuth({
        serverUrl: transport.url,
        provider,
        transportOptions: fetchOption,
      });
    } catch (error) {
      if (isMcpUnauthorizedError(error)) {
        throw new ToolSourceAuthorizationRequiredError(sourceId, { cause: error });
      }
      throw error;
    }
  }

  if (authentication?.type === 'bearer') {
    const name = authentication.credential;
    // Resolved once up front so a missing credential fails the load with a named error, then on
    // every request so a rotated value is picked up without reloading the source.
    await requireCredential(sourceId, name, options);
    return connectUntilAborted(
      new StreamableHTTPClientTransport(new URL(transport.url), {
        ...fetchOption,
        authProvider: { token: () => requireCredential(sourceId, name, options) },
      }),
      options.signal,
    );
  }

  return connectUntilAborted(
    new StreamableHTTPClientTransport(new URL(transport.url), fetchOption),
    options.signal,
  );
}

/** The OAuth provider for one source, built the same way to start a flow and to complete it. */
function createToolSourceOAuthProvider(
  sourceId: string,
  authentication: { scope?: string | undefined; clientName?: string | undefined },
  oauth: ToolSourceOAuthOptions,
) {
  const redirectUrl = oauth.redirectUrl(sourceId);
  const clientMetadata: OAuthClientMetadata = {
    client_name: authentication.clientName ?? 'armorer-mcp-client',
    redirect_uris: [String(redirectUrl)],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(authentication.scope ? { scope: authentication.scope } : {}),
  };
  return createMcpOAuthProvider({
    redirectUrl,
    clientMetadata,
    tokenStorage: oauth.tokenStorage(sourceId),
    onAuthorizationRequired: (authorizationUrl) =>
      oauth.onAuthorizationRequired(sourceId, authorizationUrl),
  });
}

/**
 * Finishes the sign-in of an MCP source that authenticates with `oauth`, once the user's browser
 * has been sent back to the redirect URL. `callbackUrl` is the full URL (or just the query string)
 * the authorization server redirected to. The `state` and issuer are checked against what the
 * flow recorded in the source's token storage, and the code is exchanged for tokens, which are
 * saved through the same storage. Load the source again afterwards to list its tools.
 *
 * @throws {ToolSourceDescriptionError} for an invalid description.
 * @throws {Error} when the source does not authenticate with `oauth`, or the callback does not
 *   match the flow it recorded. No message repeats a URL.
 */
export async function completeToolSourceAuthorization(
  description: ToolSourceDescription,
  options: {
    /** The same host-owned pieces given to {@link loadToolSource}. */
    oauth: ToolSourceOAuthOptions;
    /** The URL the authorization server redirected the user's browser to. */
    callbackUrl: string | URL;
    /** Fetch for the token exchange. Defaults to the global `fetch`. */
    fetch?: typeof fetch;
  },
): Promise<void> {
  const source = parseToolSourceDescription(description);
  const authentication =
    source.kind === 'mcp' && source.transport.type === 'http'
      ? source.transport.authentication
      : undefined;
  if (
    source.kind !== 'mcp' ||
    source.transport.type !== 'http' ||
    authentication?.type !== 'oauth'
  ) {
    throw new Error(`Tool source "${source.id}" does not authenticate with OAuth.`);
  }
  // Caller-owned, read after the awaits below.
  const oauth = { ...options.oauth };
  const provider = createToolSourceOAuthProvider(source.id, authentication, oauth);
  await completeMcpOAuthAuthorization(provider, {
    serverUrl: source.transport.url,
    callbackUrl: options.callbackUrl,
    tokenStorage: oauth.tokenStorage(source.id),
    ...(options.fetch ? { fetchFn: options.fetch } : {}),
  });
}

async function connectStdio(
  sourceId: string,
  transport: Extract<McpToolSourceDescription['transport'], { type: 'stdio' }>,
  options: LoadToolSourceOptions,
): Promise<Client> {
  // Node-only, so it is imported only for a source that needs it.
  const { StdioClientTransport, getDefaultEnvironment } =
    await import('@modelcontextprotocol/client/stdio');
  const credentialEnvironment: Record<string, string> = {};
  for (const [variable, credential] of Object.entries(transport.credentialEnv ?? {})) {
    credentialEnvironment[variable] = await requireCredential(sourceId, credential, options);
  }
  return connectUntilAborted(
    new StdioClientTransport({
      command: transport.command,
      ...(transport.args ? { args: transport.args } : {}),
      ...(transport.cwd ? { cwd: transport.cwd } : {}),
      env: { ...getDefaultEnvironment(), ...transport.env, ...credentialEnvironment },
    }),
    options.signal,
  );
}

async function loadOpenApiSource(
  source: OpenApiToolSourceDescription,
  options: LoadToolSourceOptions,
): Promise<LoadedToolSource> {
  const fetchImplementation = options.fetch ?? fetch;
  const { specification, documentUrl } =
    source.specification.type === 'document'
      ? { specification: source.specification.document, documentUrl: undefined }
      : await fetchSpecification(
          source.id,
          source.specification.url,
          fetchImplementation,
          options.signal,
        );
  const authentication = source.authentication;
  const auth: OpenAPIAuth | undefined =
    authentication?.type === 'bearer'
      ? {
          type: 'bearer',
          token: await requireCredential(source.id, authentication.credential, options),
        }
      : authentication?.type === 'api-key'
        ? {
            type: 'api-key',
            header: authentication.header,
            value: await requireCredential(source.id, authentication.credential, options),
          }
        : undefined;
  const baseUrl = resolveBaseUrl(source, specification, documentUrl);
  const tools = createToolboxFromOpenAPI(specification, {
    fetch: fetchImplementation,
    baseUrl,
    ...(auth ? { auth } : {}),
    ...(source.allowOperations ? { allowOperations: source.allowOperations } : {}),
    ...(source.namePrefix ? { namePrefix: source.namePrefix } : {}),
    // What a person approves of the tool (see `tool-version.ts`): an approval is bound to it.
    version: (operation) => versionOfMaterial(['openapi', source.id, baseUrl, operation]),
  });
  return { id: source.id, kind: 'openapi', tools, close: async () => undefined };
}

/**
 * The base URL requests go to: the description's `baseUrl`, else the document's first server. A
 * relative server URL resolves against the URL the document was finally served from (after redirects) when it was fetched, and is an error
 * for an inline document, which has nothing to resolve it against.
 */
function resolveBaseUrl(
  source: OpenApiToolSourceDescription,
  specification: OpenAPISpec,
  documentUrl: string | undefined,
): string {
  if (source.baseUrl) return source.baseUrl;
  const server = specification.servers?.[0]?.url;
  if (!server) {
    throw new ToolSourceBaseUrlError(
      source.id,
      'it has no `baseUrl` and its document lists no server.',
    );
  }
  let resolved: URL;
  try {
    resolved = new URL(server, documentUrl);
  } catch {
    throw new ToolSourceBaseUrlError(
      source.id,
      'its first server URL is not an absolute http(s) URL and there is no document URL to resolve it against; set `baseUrl`. The URL is left out of this message because it may carry a credential.',
    );
  }
  if (
    (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') ||
    resolved.username !== '' ||
    resolved.password !== ''
  ) {
    throw new ToolSourceBaseUrlError(
      source.id,
      'its server URL must be an http(s) URL without a username or password; set `baseUrl`.',
    );
  }
  return resolved.href;
}

/** The largest OpenAPI document fetched from a URL; a larger one is refused before it is parsed. */
const MAXIMUM_SPECIFICATION_BYTES = 3_000_000;

/**
 * The document is fetched without credentials: they belong to the API, which may be another host.
 * The fetch ends when `signal` aborts, and the body is read only up to
 * {@link MAXIMUM_SPECIFICATION_BYTES}, so a host that never answers or never stops sending cannot
 * hold the load.
 */
async function fetchSpecification(
  sourceId: string,
  url: string,
  fetchImplementation: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<{ specification: OpenAPISpec; documentUrl: string }> {
  const response = await fetchImplementation(url, {
    headers: { accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    throw new Error(
      `Tool source "${sourceId}": fetching its OpenAPI document failed with HTTP ${response.status}.`,
    );
  }
  const text = await readBoundedText(response, MAXIMUM_SPECIFICATION_BYTES);
  if (text === undefined) {
    throw new Error(
      `Tool source "${sourceId}": its OpenAPI document is larger than ${MAXIMUM_SPECIFICATION_BYTES} bytes.`,
    );
  }
  try {
    // `response.url` is the final URL after redirects; a relative server URL resolves against it.
    return {
      specification: JSON.parse(text) as OpenAPISpec,
      documentUrl: response.url || url,
    };
  } catch (error) {
    throw new Error(
      `Tool source "${sourceId}": its OpenAPI document is not valid JSON (YAML documents are not supported).`,
      { cause: error },
    );
  }
}

/** The body as text, or `undefined` once it passes `limit` bytes, when the rest is not read. */
async function readBoundedText(response: Response, limit: number): Promise<string | undefined> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function onceAsync(work: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => (pending ??= work());
}
