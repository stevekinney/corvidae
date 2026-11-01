/**
 * The host's saved tool sources, as Capabilities › Sources reads and changes them
 * (`/host/tool-sources`; `src/host/tool-source-routes.ts`). The host never answers with a
 * credential or a URL, only the names of the credentials it holds. A source is connected, or
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

const toolSchema = z.object({
  name: z.string(),
  tool: z.string(),
  acceptsSecrets: z.boolean(),
  savedAcceptsSecrets: z.boolean(),
  tier: z.string().nullable(),
});

const sourceSchema = z.object({
  id: z.string(),
  kind: z.enum(TOOL_SOURCE_KINDS),
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
  sources: z.array(sourceSchema),
  lockReason: z.enum(SETTING_LOCK_REASONS).optional(),
});

const changeSchema = z.object({
  id: z.string(),
  changed: z.boolean(),
  restartRequired: z.boolean(),
});

const affectedAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  tools: z.array(z.string()),
  toolApproval: z.array(z.string()),
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
    tools: z.array(z.object({ name: z.string(), tool: z.string(), tier: z.string().nullable() })),
    skipped: z.array(z.object({ tool: z.string(), reason: z.string() })),
  }),
  z.object({ outcome: z.literal('needs-authorization') }),
  z.object({ outcome: z.literal('failed'), message: z.string() }),
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
};

/** What a connect reports: the source is saved, and its tools are listed when the host starts again. */
export type ToolSourceChange = z.infer<typeof changeSchema>;

/** What starting a sign-in reports: the address to open, or that the stored tokens already work. */
export type ToolSourceAuthorization = z.infer<typeof authorizationSchema>;

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
 * Saves a source, or replaces the one with the same `id`. It is listed, with its tools, when the
 * host starts again.
 *
 * @throws {HostToolSourceError} When the host refuses it, with the field it names.
 */
export async function connectToolSource(
  id: string,
  request: ToolSourceRequest,
  options: Options = {},
): Promise<ToolSourceChange> {
  const response = await send(sourcePath(id), jsonRequest('PUT', request), options);
  return readJson(response, changeSchema);
}

function jsonRequest(method: string, request: ToolSourceRequest): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: request.source,
      credentials: request.credentials,
      ...(request.create === true ? { create: true } : {}),
    }),
  };
}

/**
 * Sets whether each named tool of `id` may receive the plaintext of a secret answer. `tools` maps a
 * tool's own name (not `<id>__<tool>`) to the choice; `false` removes the setting, which is the
 * default. The host loads the change at its next start.
 *
 * @throws {HostToolSourceError} When the host refuses the change.
 */
export async function setAcceptsSecrets(
  id: string,
  tools: Readonly<Record<string, boolean>>,
  options: Options = {},
): Promise<void> {
  const settings = Object.fromEntries(
    Object.entries(tools).map(([tool, acceptsSecrets]) => [tool, { acceptsSecrets }]),
  );
  const response = await send(
    sourcePath(id, '/tools'),
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tools: settings }),
    },
    options,
  );
  await readJson(response, changeSchema);
}

/**
 * Starts an MCP sign-in for `id`. The host answers with the address to open in a new tab, or that
 * the stored tokens already work.
 *
 * @throws {HostToolSourceError} When the host cannot start the sign-in.
 */
export async function authorizeToolSource(
  id: string,
  options: Options = {},
): Promise<ToolSourceAuthorization> {
  const response = await send(sourcePath(id, '/authorize'), { method: 'POST' }, options);
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
  options: Options = {},
): Promise<ToolSourceRemoved> {
  const response = await send(sourcePath(id), { method: 'DELETE' }, options);
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
