/**
 * The host's plugins, as Settings › Plugins reads and changes them (`GET /host/plugins`,
 * `PUT /host/plugins/<name>`, `PUT /host/plugins/<name>/secrets/<key>`, `POST /host/restart`;
 * `src/host/plugin-routes.ts`, `src/host/restart.ts`). The host never answers with a secret's
 * value, and this module never keeps the one it sends: the value is in the request body for the
 * length of one call, and a failure is described by the host's message, which names the field and
 * never the value. A message that somehow held the value is replaced before it leaves here.
 */
import { z } from 'zod';

import type { Fetcher } from './bureau-client.ts';
import { SETTING_LOCK_REASONS } from './bureau-settings.ts';

/** The route that reports the plugins. */
export const HOST_PLUGINS_ROUTE = '/host/plugins';

/** The route that restarts the host: a `POST`, answered `202` before the host stops. */
export const HOST_RESTART_ROUTE = '/host/restart';

const referencesSchema = z.object({
  agents: z.number(),
  schedules: z.number(),
  waitingRuns: z.number(),
});

const contributionSchema = z.object({
  kind: z.string(),
  id: z.string(),
  references: referencesSchema,
});

// A problem is read by its `code`; the fields each code carries are read where it is worded
// (`routes/settings/plugins/plugin-problems.ts`), so a code this client does not know still lists.
const problemSchema = z.looseObject({ code: z.string() });

const secretSchema = z.object({
  key: z.string(),
  generated: z.boolean(),
  set: z.boolean(),
  location: z.string(),
});

const pluginSchema = z.object({
  descriptor: z.object({
    name: z.string().min(1),
    version: z.string(),
    description: z.string(),
    required: z.boolean(),
    enabledByDefault: z.boolean(),
  }),
  source: z.enum(['package', 'folder', 'built-in']),
  location: z.string(),
  status: z.enum(['running', 'needs-setup', 'disabled', 'skipped']),
  problems: z.array(problemSchema),
  contributions: z.array(contributionSchema),
  enabled: z.boolean(),
  configuration: z.unknown(),
  secrets: z.array(secretSchema),
  restartRequired: z.boolean(),
});

const unloadedSchema = z.object({
  source: z.enum(['package', 'folder', 'built-in']),
  location: z.string(),
  status: z.literal('skipped'),
  problems: z.array(problemSchema),
});

const pluginsSchema = z.object({
  plugins: z.array(pluginSchema),
  unloaded: z.array(unloadedSchema),
  lockReason: z.enum(SETTING_LOCK_REASONS).optional(),
});

/** The plugins the host loaded, the folders it could not load, and why writes are refused, if they are. */
export type PluginsSnapshot = z.infer<typeof pluginsSchema>;

/** One plugin of {@link PluginsSnapshot}. */
export type PluginStanding = PluginsSnapshot['plugins'][number];

/** One thing a plugin adds, with what names it now. */
export type PluginContribution = PluginStanding['contributions'][number];

/** One problem a plugin or a folder has; the `code` says which, and the other fields vary with it. */
export type PluginProblem = z.infer<typeof problemSchema>;

/** One secret a plugin declares, with whether it is saved. Never its value. */
export type PluginSecret = PluginStanding['secrets'][number];

/** A folder the host could not load a plugin from. */
export type UnloadedPlugin = PluginsSnapshot['unloaded'][number];

/** What the host reports after it stores a plugin's choices. */
export type PluginChange = {
  /** The plugin's name. */
  readonly plugin: string;
  /** Whether the stored choices have it enabled. */
  readonly enabled: boolean;
  /** The stored configuration, or `{}`. */
  readonly configuration: unknown;
  /** Whether the stored choices differ from the ones the running host loaded. */
  readonly restartRequired: boolean;
};

const changeSchema = z.object({
  plugin: z.string(),
  enabled: z.boolean(),
  configuration: z.unknown(),
  restartRequired: z.boolean(),
});

/** Why a change to the plugins failed. */
export type HostPluginFaultKind =
  /** The host refuses the write: it keeps its plugin choices and secrets in its deployment. */
  | 'locked'
  /** The host refused a value; `field` names it. */
  | 'invalid'
  /** The host has no plugin of that name. */
  | 'not-found'
  /** The host could not make the change, or did not answer in a form this page reads. */
  | 'failed';

/** A change the host did not make. The message never holds a secret. */
export class HostPluginError extends Error {
  /** What went wrong, in a form the page words for a person. */
  readonly kind: HostPluginFaultKind;
  /** The field the host named, for an `invalid` answer. */
  readonly field: string | undefined;

  constructor(kind: HostPluginFaultKind, message: string, field?: string) {
    super(message);
    this.name = 'HostPluginError';
    this.kind = kind;
    this.field = field;
  }
}

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

function send(path: string, init: RequestInit, options: Options): Promise<Response> {
  const request = options.fetch ?? fetch;
  return request(path, options.signal === undefined ? init : { ...init, signal: options.signal });
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** The fault a refused answer stands for. `secret` is a value the message must not carry. */
async function faultOf(response: Response, secret?: string): Promise<HostPluginError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new HostPluginError('failed', '');
  }
  const record = typeof body === 'object' && body !== null ? body : {};
  const error: unknown = Reflect.get(record, 'error');
  const rawMessage: unknown = Reflect.get(record, 'message');
  const field: unknown = Reflect.get(record, 'field');
  const message =
    typeof rawMessage === 'string' && (secret === undefined || !rawMessage.includes(secret))
      ? rawMessage
      : '';
  if (error === 'locked') return new HostPluginError('locked', message);
  if (error === 'not-found') return new HostPluginError('not-found', message);
  if (error === 'invalid') {
    return new HostPluginError('invalid', message, typeof field === 'string' ? field : undefined);
  }
  return new HostPluginError('failed', message);
}

/** Asks the host for its plugins: their standing, what they add, what names it, and their secrets. */
export async function getPlugins(options: Options = {}): Promise<PluginsSnapshot> {
  const response = await send(HOST_PLUGINS_ROUTE, {}, options);
  if (!response.ok) throw new Error(`The host answered ${response.status}.`);
  return pluginsSchema.parse(await response.json());
}

/**
 * Stores the owner's choices for one plugin. A field left out keeps what is stored, and a
 * `configuration` of `null` removes it. The change reaches the running host at its next start,
 * except a provider plugin's allowlist, which applies at once; `restartRequired` says which.
 *
 * @throws {HostPluginError} When the host refuses the change.
 */
export async function updatePlugin(
  name: string,
  change: { readonly enabled?: boolean; readonly configuration?: unknown },
  options: Options = {},
): Promise<PluginChange> {
  const response = await send(
    `${HOST_PLUGINS_ROUTE}/${encodeURIComponent(name)}`,
    jsonRequest('PUT', change),
    options,
  );
  if (!response.ok) throw await faultOf(response);
  return changeSchema.parse(await response.json());
}

/**
 * Stores a secret the plugin declared. The value travels in this one request; nothing here keeps
 * it. The plugin's contributions that wait for it work at once, with no restart.
 *
 * @throws {HostPluginError} When the host refuses the secret.
 */
export async function savePluginSecret(
  name: string,
  key: string,
  value: string,
  options: Options = {},
): Promise<void> {
  const response = await send(
    `${HOST_PLUGINS_ROUTE}/${encodeURIComponent(name)}/secrets/${encodeURIComponent(key)}`,
    jsonRequest('PUT', { value }),
    options,
  );
  if (!response.ok) throw await faultOf(response, value);
}

/**
 * Asks the host to restart. It answers `202` and then stops; the supervisor starts it again, which
 * loads the plugins as they are stored.
 *
 * @throws {HostPluginError} When the host will not restart, for example because nothing supervises it.
 */
export async function restartHost(options: Options = {}): Promise<void> {
  const response = await send(HOST_RESTART_ROUTE, { method: 'POST' }, options);
  if (!response.ok) throw await faultOf(response);
}
