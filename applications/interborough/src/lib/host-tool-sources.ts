/**
 * The host's saved tool sources, as Capabilities › Sources reads and changes them
 * (`/host/tool-sources`; `src/host/tool-source-routes.ts`). The host never answers with a
 * credential, only the names of the credentials it holds; the one address it answers with is a
 * source's own, cut to its origin and path (COR-2022). A source is connected, or
 * probed before it is saved, from a description and the credentials it names
 * (`tool-source-form.ts` builds both); those values go out in one request body and are never kept
 * here, logged, or put in an error. A failure is described by the host's message, which names a
 * field and never a value.
 */
import { z } from 'zod';

import { CAPABILITIES_COPY } from '../app/copy.ts';
import type { Fetcher } from './bureau-client.ts';
import { SETTING_LOCK_REASONS } from './bureau-settings.ts';
import { faultTreatment, type FaultTreatment } from './faults.ts';

/** The route that lists the saved tool sources. */
export const HOST_TOOL_SOURCES_ROUTE = '/host/tool-sources';

/** The kinds of source the host saves. */
export const TOOL_SOURCE_KINDS = ['mcp', 'openapi'] as const;

/** Where a source stands (`tool-source-manager.ts`). */
export const TOOL_SOURCE_STATES = [
  'loaded',
  'failed',
  'needs-authorization',
  'pending-restart',
] as const;

/**
 * The Default asks levels a source gives one of its tools (COR-2022), in the words an agent file's
 * `approvals` uses. `blocked` is not one: it is a per-agent override, set on an agent's Access tab.
 */
export const SOURCE_TOOL_APPROVALS = ['never', 'on-changes', 'always'] as const;

/** One of {@link SOURCE_TOOL_APPROVALS}. */
export type SourceToolApproval = (typeof SOURCE_TOOL_APPROVALS)[number];

const toolSchema = z.object({
  name: z.string(),
  tool: z.string(),
  acceptsSecrets: z.boolean(),
  savedAcceptsSecrets: z.boolean(),
  tier: z.string().nullable(),
  /**
   * Whether the running host offers the tool, and whether the saved settings turn it on (COR-2009).
   * The host sends both; absent, as from a page's own fixture, the tool reads as on.
   */
  enabled: z.boolean().optional(),
  savedEnabled: z.boolean().optional(),
  /** The tool's Default asks level, saved as it is now, or the one its tier gives (COR-2022). */
  approval: z.enum(SOURCE_TOOL_APPROVALS).optional(),
  /** Whether `approval` is the owner's own pick rather than the tier's. */
  approvalSaved: z.boolean().optional(),
});

const sourceSchema = z.object({
  id: z.string(),
  kind: z.enum(TOOL_SOURCE_KINDS),
  /** What a person calls the source ("GitHub"), or `null`: show its `id` (COR-2022). */
  name: z.string().nullable().optional(),
  /** One sentence about the source, or `null` (COR-2022). */
  description: z.string().nullable().optional(),
  /** The server URL or spec address, cut to its origin and path; `null` for a local command (COR-2022). */
  address: z.string().nullable().optional(),
  /** When the running host last reached the source, as an ISO 8601 time (COR-2022). */
  lastTested: z.string().optional(),
  localCommand: z.boolean(),
  state: z.enum(TOOL_SOURCE_STATES),
  message: z.string().optional(),
  tools: z.array(toolSchema),
  skipped: z.array(z.object({ tool: z.string(), reason: z.string() })),
  unmatchedSettings: z.array(z.object({ tool: z.string(), message: z.string() })),
  settingsPending: z.literal(true).optional(),
  credentials: z.array(z.string()),
  authorized: z.boolean().optional(),
  tokensRejected: z.literal(true).optional(),
});

const snapshotSchema = z.object({
  configurationRevision: z.string().nullable(),
  credentialLockReason: z.literal('deployment').optional(),
  sources: z.array(sourceSchema),
  lockReason: z.enum(SETTING_LOCK_REASONS).optional(),
});

const changeSchema = z.object({
  id: z.string(),
  changed: z.boolean(),
  restartRequired: z.boolean(),
  /** For a source a connect added at once: the names of its tools that are on and available now (COR-2009). */
  available: z.array(z.string()).optional(),
});

const affectedAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  tools: z.array(z.string()),
  approvals: z.array(z.string()),
});

const removalPreviewSchema = z.object({
  id: z.string(),
  tools: z.array(z.string()),
  affectedAgents: z.array(affectedAgentSchema),
});

const removedSchema = changeSchema.extend({ affectedAgents: z.array(affectedAgentSchema) });

const probeSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('listed'),
    tools: z.array(
      z.object({
        name: z.string(),
        tool: z.string(),
        tier: z.string().nullable(),
        /** Its name for a person ("List issues"), or `null` when the source gives none. */
        title: z.string().nullable().optional(),
        /** What it does, as the source describes it. */
        description: z.string().optional(),
      }),
    ),
    skipped: z.array(z.object({ tool: z.string(), reason: z.string() })),
    /** For an OpenAPI source: the read the test made with the key, and whether it passed. */
    test: z
      .object({
        tool: z.string(),
        title: z.string().nullable(),
        passed: z.boolean(),
        message: z.string().optional(),
      })
      .optional(),
  }),
  z.object({ outcome: z.literal('needs-authorization') }),
  z.object({ outcome: z.literal('failed'), message: z.string() }),
]);

const operationTierSchema = z.enum(['read-only', 'mutating', 'dangerous']);

const inspectionSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('valid'),
    fileName: z.string().nullable(),
    version: z.string(),
    title: z.string().nullable(),
    baseUrl: z.string().nullable(),
    operationCount: z.number(),
    operations: z.array(
      z.object({
        operationId: z.string().nullable(),
        method: z.string(),
        path: z.string(),
        title: z.string().nullable(),
        description: z.string().nullable(),
        tier: operationTierSchema,
      }),
    ),
    testOperation: z
      .object({
        operationId: z.string(),
        title: z.string().nullable(),
        method: z.literal('GET'),
        path: z.string(),
      })
      .nullable(),
    document: z.record(z.string(), z.unknown()),
  }),
  z.object({
    outcome: z.literal('invalid'),
    fileName: z.string().nullable(),
    line: z.number().nullable(),
    problem: z.string(),
    message: z.string(),
  }),
  z.object({
    outcome: z.literal('no-operation-ids'),
    fileName: z.string().nullable(),
    version: z.string(),
    operationCount: z.number(),
    message: z.string(),
  }),
  z.object({
    outcome: z.literal('unreachable'),
    status: z.number().nullable(),
    message: z.string(),
  }),
]);

const authorizationSchema = z.union([
  z.object({ authorized: z.literal(true) }),
  z.object({ authorized: z.literal(false), authorizationUrl: z.string() }),
]);

/** One saved tool source with where it stands, the tools it offers and the names of its credentials. */
export type ToolSourceStanding = z.infer<typeof sourceSchema>;

/** One tool a source offers, under the name an agent file uses. */
export type ToolSourceTool = ToolSourceStanding['tools'][number];

/** The saved tool sources, and why changes are refused when they are. */
export type ToolSourcesSnapshot = z.infer<typeof snapshotSchema>;

/** An agent file that names a tool of a source. */
export type ToolSourceAgent = z.infer<typeof affectedAgentSchema>;

/** What a removal would break, or did. */
export type ToolSourceRemoval = z.infer<typeof removalPreviewSchema>;

/** What a removal did: the agent files that name the removed source's tools, as the host read them when it removed it. */
export type ToolSourceRemoved = z.infer<typeof removedSchema>;

/** What a probe found: the tools the source lists, that it asks for a sign-in, or why it did not answer. */
export type ToolSourceProbe = z.infer<typeof probeSchema>;

/** What a connect or a probe sends: Armorer's description of the source, and the value of each credential it names. */
export type ToolSourceRequest = {
  /** The description (`armorer/tool-sources`): plain JSON that names credentials and holds none. */
  readonly source: Readonly<Record<string, unknown>>;
  /** Credential name to value, for each credential `source` names. */
  readonly credentials: Readonly<Record<string, string>>;
  /** For a connect: refuse, instead of replacing, a source already saved under the same name. */
  readonly create?: true;
  /** For a connect: what a person calls the source ("GitHub"). Left out, the saved name is kept (COR-2022). */
  readonly name?: string;
  /** For a connect: one sentence about the source. Empty clears it; left out, the saved one is kept (COR-2022). */
  readonly description?: string;
  /**
   * For a connect: the person's choice of tools (COR-2022, Choose tools), by each tool's own name
   * (a probe's `tool`, never the `<id>__<tool>` name). It replaces the settings saved for the
   * source; left out, a new source's tools are all on at the level their tier gives.
   */
  readonly tools?: Readonly<Record<string, ToolSourceToolSettings>>;
};

/**
 * The host's settings for one tool of a source, as a change names them (COR-2022): a field left out
 * keeps its saved value, and `approval: null` returns the tool to the level its tier gives.
 */
export type ToolSourceToolSettings = {
  /** Whether the tool may receive the plaintext of a secret answer. */
  readonly acceptsSecrets?: boolean;
  /** Whether the host offers the tool to agents: the On checkbox. */
  readonly enabled?: boolean;
  /** The tool's Default asks level, or `null` for the one its tier gives. */
  readonly approval?: SourceToolApproval | null;
};

/**
 * What a connect reports. A source a connect adds is loaded at once, with `restartRequired: false`
 * and the tools now available in `available`; a change to a saved source is listed when the host
 * starts again.
 */
export type ToolSourceChange = z.infer<typeof changeSchema>;

/** What starting a sign-in reports: the address to open, or that the stored tokens already work. */
export type ToolSourceAuthorization = z.infer<typeof authorizationSchema>;

/**
 * What the host made of an OpenAPI spec before it is connected (`src/host/openapi-inspection.ts`):
 * a `valid` spec with its title, first server, operations and the read Test connection makes; an
 * `invalid` file with the line its problem is on; a valid spec in which `no-operation-ids` name a
 * tool; or an address that was `unreachable`. Each but `valid` carries the whole message a page shows.
 */
export type OpenApiInspection = z.infer<typeof inspectionSchema>;

/** One operation of a `valid` spec, as Choose tools lists it. */
export type OpenApiOperation = Extract<
  OpenApiInspection,
  { outcome: 'valid' }
>['operations'][number];

/** What a spec is read from: the text of a file the person chose, or its address. */
export type OpenApiSpecInput =
  { readonly text: string; readonly fileName: string } | { readonly url: string };

/** The route that reads an OpenAPI spec before it is connected, and saves nothing. */
export const HOST_OPENAPI_INSPECTION_ROUTE = '/host/openapi-inspection';

/** Why a change to a source failed. */
export type HostToolSourceFaultKind =
  /** The host refuses the write: it keeps its configuration in its deployment. */
  | 'locked'
  /** A source is already saved under that name, and the request asked not to replace it. */
  | 'exists'
  /** Only the owner may do this. */
  | 'owner-only'
  /** The host has no such source. */
  | 'not-found'
  /** The host refused a value; `field` names it. */
  | 'invalid'
  /** The host applied part of the change; `message` says what is left. */
  | 'partial'
  /** The host could not make the change, or did not answer in a form this page reads. */
  | 'failed';

/** A change the host did not make. The message is the host's, which names no value. */
export class HostToolSourceError extends Error {
  /** What went wrong, in a form the page words for a person. */
  readonly kind: HostToolSourceFaultKind;
  /** The field the host named, for an `invalid` answer. */
  readonly field: string | undefined;

  constructor(kind: HostToolSourceFaultKind, message: string, field?: string) {
    super(message);
    this.name = 'HostToolSourceError';
    this.kind = kind;
    this.field = field;
  }
}

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

type MutationOptions = Options & {
  readonly mutation?: { readonly operationId: string; readonly expectedRevision: string | null };
};

async function mutationInput(options: MutationOptions) {
  if (options.mutation !== undefined) return { ...options.mutation };
  const snapshot = await getToolSources(options);
  return { operationId: crypto.randomUUID(), expectedRevision: snapshot.configurationRevision };
}

function send(path: string, init: RequestInit, options: Options): Promise<Response> {
  const request = options.fetch ?? fetch;
  return request(path, options.signal === undefined ? init : { ...init, signal: options.signal });
}

function sourcePath(id: string, suffix = ''): string {
  return `${HOST_TOOL_SOURCES_ROUTE}/${encodeURIComponent(id)}${suffix}`;
}

/** The fault a refused answer stands for. */
async function faultOf(response: Response): Promise<HostToolSourceError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new HostToolSourceError('failed', '');
  }
  const record = typeof body === 'object' && body !== null ? body : {};
  const error: unknown = Reflect.get(record, 'error');
  const rawMessage: unknown = Reflect.get(record, 'message');
  const field: unknown = Reflect.get(record, 'field');
  const message = typeof rawMessage === 'string' ? rawMessage : '';
  switch (error) {
    case 'locked':
    case 'exists':
    case 'owner-only':
    case 'not-found':
    case 'partial':
      return new HostToolSourceError(error, message);
    case 'invalid':
      return new HostToolSourceError(
        'invalid',
        message,
        typeof field === 'string' ? field : undefined,
      );
    default:
      return new HostToolSourceError('failed', message);
  }
}

async function readJson<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
): Promise<z.infer<Schema>> {
  if (!response.ok) throw await faultOf(response);
  try {
    return schema.parse(await response.json());
  } catch {
    throw new HostToolSourceError('failed', '');
  }
}

/** Asks the host for its saved tool sources, where each stands, and the tools each offers. */
export async function getToolSources(options: Options = {}): Promise<ToolSourcesSnapshot> {
  const response = await send(HOST_TOOL_SOURCES_ROUTE, {}, options);
  if (!response.ok) throw new Error(`The host answered ${response.status}.`);
  return snapshotSchema.parse(await response.json());
}

/**
 * Contacts a source that is not saved, with the credentials in `request` and none from the host,
 * and reports the tools it lists, that it asks for a sign-in, or why it did not answer. Nothing is
 * saved. The reason holds no address, command or value.
 *
 * @throws {HostToolSourceError} When the host refuses the request: it cannot be used (`invalid`,
 * naming the field), the host is `locked`, or a local command is asked for by anyone but the owner.
 */
export async function probeToolSource(
  id: string,
  request: ToolSourceRequest,
  options: Options = {},
): Promise<ToolSourceProbe> {
  const response = await send(sourcePath(id, '/probe'), jsonRequest('POST', request), options);
  return readJson(response, probeSchema);
}

/**
 * Asks the host to read an OpenAPI spec (COR-2022, rows 33t, 34s, 34u, 34v): the text of a file,
 * JSON or YAML, or the spec at an address the host fetches. Nothing is saved. Pass a `signal` to
 * stop a fetch the person cancels.
 *
 * @throws {HostToolSourceError} When the host refuses the request (`invalid`: no text and no
 * address, or an address that is not http or https).
 */
export async function inspectOpenApi(
  input: OpenApiSpecInput,
  options: Options = {},
): Promise<OpenApiInspection> {
  // Copied before the first `await`: the caller owns the input.
  const body = 'url' in input ? { url: input.url } : { text: input.text, fileName: input.fileName };
  const response = await send(
    HOST_OPENAPI_INSPECTION_ROUTE,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    options,
  );
  return readJson(response, inspectionSchema);
}

/**
 * Contacts a saved source with the credentials and sign-in the host holds for it, and reports the
 * tools it lists, that it asks for a sign-in, or why it did not answer, as {@link probeToolSource}
 * does (COR-2022, Test connection on a saved source). Nothing is saved; a source that lists its
 * tools moves its `lastTested`.
 *
 * @throws {HostToolSourceError} When the host refuses the request: no such source (`not-found`),
 * or a local command asked for by anyone but the owner.
 */
export async function testToolSource(id: string, options: Options = {}): Promise<ToolSourceProbe> {
  const response = await send(
    sourcePath(id, '/test'),
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    options,
  );
  return readJson(response, probeSchema);
}

/**
 * Saves a source, or replaces the one with the same `id`, with its name, description and the
 * person's choice of tools when `request` carries them. A source this adds is loaded at once and
 * its tools are available with no restart (`restartRequired: false`, `available`).
 *
 * @throws {HostToolSourceError} When the host refuses it, with the field it names.
 */
export async function connectToolSource(
  id: string,
  request: ToolSourceRequest,
  options: MutationOptions = {},
): Promise<ToolSourceChange> {
  // Copied before the first `await`: the caller owns the request and may change it meanwhile.
  const captured = z.record(z.string(), z.unknown()).parse(
    JSON.parse(
      JSON.stringify({
        source: request.source,
        credentials: request.credentials,
        ...(request.create === true ? { create: true } : {}),
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.description === undefined ? {} : { description: request.description }),
        ...(request.tools === undefined ? {} : { tools: request.tools }),
      }),
    ),
  );
  const mutation = await mutationInput(options);
  const response = await send(
    sourcePath(id),
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...mutation, ...captured }),
    },
    options,
  );
  return readJson(response, changeSchema);
}

function jsonRequest(
  method: string,
  request: ToolSourceRequest,
  mutation?: MutationOptions['mutation'],
): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...mutation,
      source: request.source,
      credentials: request.credentials,
      ...(request.create === true ? { create: true } : {}),
    }),
  };
}

/**
 * Saves the named settings of each named tool of `id` at once (COR-2022: the On checkbox and the
 * Default asks select save as they change). `tools` maps a tool's own name (not `<id>__<tool>`) to
 * the fields to set; a field left out keeps its saved value, so one control never resets another.
 * The host loads the change at its next start.
 *
 * @throws {HostToolSourceError} When the host refuses the change, naming the field (`blocked` is
 * refused for a source: it belongs to one agent).
 */
export async function setToolSettings(
  id: string,
  tools: Readonly<Record<string, ToolSourceToolSettings>>,
  options: MutationOptions = {},
): Promise<void> {
  // Copied before the first `await`: the caller owns the record.
  const settings = Object.fromEntries(
    Object.entries(tools).map(([tool, change]) => [tool, { ...change }]),
  );
  const mutation = await mutationInput(options);
  const response = await send(
    sourcePath(id, '/tools'),
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tools: settings, ...mutation }),
    },
    options,
  );
  await readJson(response, changeSchema);
}

/**
 * Sets whether each named tool of `id` may receive the plaintext of a secret answer. `tools` maps a
 * tool's own name (not `<id>__<tool>`) to the choice; `false` removes the setting, which is the
 * default. The tool's other settings are kept. The host loads the change at its next start.
 *
 * @throws {HostToolSourceError} When the host refuses the change.
 */
export async function setAcceptsSecrets(
  id: string,
  tools: Readonly<Record<string, boolean>>,
  options: MutationOptions = {},
): Promise<void> {
  await setToolSettings(
    id,
    Object.fromEntries(
      Object.entries(tools).map(([tool, acceptsSecrets]) => [tool, { acceptsSecrets }]),
    ),
    options,
  );
}

/** Whether a tool is on as saved: what the On checkbox shows. A tool the host reports nothing about is on. */
export function isToolOn(tool: Pick<ToolSourceTool, 'enabled' | 'savedEnabled'>): boolean {
  return (tool.savedEnabled ?? tool.enabled) !== false;
}

/** How many of a source's tools are on as saved, and how many it lists (row 31r: "2 of 3 tools are on"). */
export function toolsOnCount(source: Pick<ToolSourceStanding, 'tools'>): {
  readonly on: number;
  readonly total: number;
} {
  return { on: source.tools.filter((tool) => isToolOn(tool)).length, total: source.tools.length };
}

/**
 * Starts an MCP sign-in for `id`. The host answers with the address to open in a new tab, or that
 * the stored tokens already work.
 *
 * @throws {HostToolSourceError} When the host cannot start the sign-in.
 */
export async function authorizeToolSource(
  id: string,
  options: MutationOptions = {},
): Promise<ToolSourceAuthorization> {
  const mutation = await mutationInput(options);
  const response = await send(
    sourcePath(id, '/authorize'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mutation),
    },
    options,
  );
  return readJson(response, authorizationSchema);
}

/**
 * Reads the agent files a removal of `id` would leave invalid, and changes nothing.
 *
 * @throws {HostToolSourceError} When the host has no such source.
 */
export async function previewToolSourceRemoval(
  id: string,
  options: Options = {},
): Promise<ToolSourceRemoval> {
  const response = await send(sourcePath(id, '/affected-agents'), {}, options);
  return readJson(response, removalPreviewSchema);
}

/**
 * Removes `id` and clears its credentials, and answers with the agent files that named its tools.
 * No agent file is edited; the ones that name its tools read invalid when the host starts again.
 *
 * @throws {HostToolSourceError} When the host refuses the removal. `partial` means the source is
 * already gone and only part of the cleanup is left.
 */
export async function removeToolSource(
  id: string,
  options: MutationOptions = {},
): Promise<ToolSourceRemoved> {
  const mutation = await mutationInput(options);
  const response = await send(
    sourcePath(id),
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mutation),
    },
    options,
  );
  return readJson(response, removedSchema);
}

/**
 * How a failed change to a tool source is shown. The host's own refusal is worded by the host and
 * names a field, never a value, so it is shown as it came; only an error that is not the host's
 * (a connection that failed) gets the generic treatment.
 */
export function toolSourceFaultTreatment(error: unknown): FaultTreatment {
  if (!(error instanceof HostToolSourceError)) return faultTreatment(error);
  const fallback = CAPABILITIES_COPY.source.refusal;
  const message = error.message === '' ? fallback[error.kind] : error.message;
  switch (error.kind) {
    case 'locked':
      return { kind: 'not-supported', message };
    case 'owner-only':
      return { kind: 'unauthorized', message, mode: 'forbidden' };
    case 'not-found':
      return { kind: 'not-found', message };
    case 'exists':
    case 'invalid':
      return { kind: 'invalid', message, fieldErrors: [] };
    case 'partial':
    case 'failed':
      return { kind: 'internal', message, maskedByRest: false, tryViaJsonRpc: false };
  }
}
