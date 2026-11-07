/**
 * The host's model providers, as Settings › Models reads and changes them (`/host/providers`,
 * `/host/catalog`, `/host/providers/reload`; `src/host/provider-routes.ts`). The host never answers
 * with an API key, and this module never keeps the one it sends: the key is in the request body for
 * the length of one call, and a failure is described by the host's message, which names the field
 * and never the value. A message that somehow held the key is replaced before it leaves here.
 */
import { z } from 'zod';

import type { Fetcher } from './bureau-client.ts';
import { SETTING_LOCK_REASONS } from './bureau-settings.ts';

/** The route that reports the providers, their models, and the catalog edits. */
export const HOST_PROVIDERS_ROUTE = '/host/providers';

/** The route that replaces the catalog edits. */
export const HOST_CATALOG_ROUTE = '/host/catalog';

/** The route that reads the configuration and the keys again. */
export const HOST_PROVIDERS_RELOAD_ROUTE = '/host/providers/reload';

const pricingSchema = z.object({
  inputPerMillionTokens: z.number(),
  outputPerMillionTokens: z.number(),
  currency: z.string(),
  cacheWritePerMillionTokens: z.number().optional(),
  cacheReadPerMillionTokens: z.number().optional(),
  longContext: z
    .object({
      inputTokensAbove: z.number(),
      inputPerMillionTokens: z.number(),
      outputPerMillionTokens: z.number(),
      cacheWritePerMillionTokens: z.number().optional(),
      cacheReadPerMillionTokens: z.number().optional(),
    })
    .nullish(),
});

const catalogEditSchema = z.object({
  provider: z.string(),
  model: z.string(),
  off: z.boolean().optional(),
  pricing: pricingSchema.optional(),
  contextWindowTokens: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  basedOn: z.string().optional(),
  decisions: z
    .object({
      kinds: z.array(z.enum(['boolean', 'choice', 'scale', 'structured'])),
      only: z.boolean(),
    })
    .optional(),
});

const providerModelSchema = z.object({
  provider: z.string(),
  model: z.string(),
  aliases: z.array(z.string()),
  contextWindowTokens: z.number(),
  maxOutputTokens: z.number(),
  streaming: z.boolean(),
  tools: z.boolean(),
  structuredOutput: z.boolean(),
  decisions: z
    .object({
      kinds: z.array(z.enum(['boolean', 'choice', 'scale', 'structured'])),
      only: z.boolean(),
    })
    .optional(),
  images: z.boolean(),
  pricing: z
    .object({
      inputPerMillionTokens: z.number(),
      outputPerMillionTokens: z.number(),
      currency: z.string(),
      cacheWritePerMillionTokens: z.number().optional(),
      cacheReadPerMillionTokens: z.number().optional(),
      longContext: z
        .object({
          inputTokensAbove: z.number(),
          inputPerMillionTokens: z.number(),
          outputPerMillionTokens: z.number(),
          cacheWritePerMillionTokens: z.number().optional(),
          cacheReadPerMillionTokens: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  off: z.boolean(),
});

const providersSchema = z.object({
  configurationRevision: z.string().nullable(),
  credentialLockReason: z.literal('deployment').optional(),
  providers: z.array(
    z.object({
      name: z.string().min(1),
      configured: z.boolean(),
      hasKey: z.boolean(),
      models: z.array(z.string()).optional(),
    }),
  ),
  catalog: z.array(catalogEditSchema),
  models: z.array(providerModelSchema),
  lockReason: z.enum(SETTING_LOCK_REASONS).optional(),
});

const keyTestSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), models: z.number().int().nonnegative() }),
  z.object({ ok: z.literal(false), status: z.number().int().optional() }),
]);

/**
 * What the provider answered to a key that was only tested, never saved: it accepted it (and how
 * many models the key would add), or it refused it, with the HTTP status when it answered at all.
 * There is never a message, because a provider's message may repeat part of the key.
 */
export type ProviderKeyTest = z.infer<typeof keyTestSchema>;

/** One edit to the catalog, as `configuration.json` holds it. */
export type CatalogEdit = z.infer<typeof catalogEditSchema>;

/** One model of the catalog, with what a person weighs: its size, its abilities, its price, and whether it is off. */
export type ProviderModel = z.infer<typeof providerModelSchema>;

/** The providers the host can call, the models it offers, and the edits to them. */
export type ProvidersSnapshot = z.infer<typeof providersSchema>;

/** One provider of {@link ProvidersSnapshot}. */
export type ProviderStatus = ProvidersSnapshot['providers'][number];

/** Why a change to the providers failed. */
export type HostProviderFaultKind =
  /** The host refuses the write: it keeps its configuration and keys in its deployment. */
  | 'locked'
  /** The catalog changed after the page read it, so the host kept what it holds and wrote nothing. */
  | 'conflict'
  /** The host refused a value; `field` names it. */
  | 'invalid'
  /** The host stored a key and could not finish; `message` says what is in use. */
  | 'partial'
  /** The host could not make the change, or did not answer in a form this page reads. */
  | 'failed';

/** A change the host did not make. The message never holds a key. */
export class HostProviderError extends Error {
  /** What went wrong, in a form the page words for a person. */
  readonly kind: HostProviderFaultKind;
  /** The field the host named, for an `invalid` answer. */
  readonly field: string | undefined;
  /** The HTTP status of an answer the page could not read, such as a 503 for the list of models. */
  readonly status: number | undefined;

  constructor(kind: HostProviderFaultKind, message: string, field?: string, status?: number) {
    super(message);
    this.name = 'HostProviderError';
    this.kind = kind;
    this.field = field;
    this.status = status;
  }
}

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/** An explicit retry keeps both fields unchanged; a new edit reads a new revision. */
type MutationOptions = Options & {
  readonly mutation?: { readonly operationId: string; readonly expectedRevision: string | null };
};

async function mutationInput(options: MutationOptions) {
  if (options.mutation !== undefined) return { ...options.mutation };
  const snapshot = await getProviders(options);
  return { operationId: crypto.randomUUID(), expectedRevision: snapshot.configurationRevision };
}

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
async function faultOf(response: Response, secret?: string): Promise<HostProviderError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new HostProviderError('failed', '');
  }
  const record = typeof body === 'object' && body !== null ? body : {};
  const error: unknown = Reflect.get(record, 'error');
  const rawMessage: unknown = Reflect.get(record, 'message');
  const field: unknown = Reflect.get(record, 'field');
  const message =
    typeof rawMessage === 'string' && (secret === undefined || !rawMessage.includes(secret))
      ? rawMessage
      : '';
  if (error === 'locked') return new HostProviderError('locked', message);
  if (error === 'conflict') return new HostProviderError('conflict', message);
  if (error === 'invalid') {
    return new HostProviderError('invalid', message, typeof field === 'string' ? field : undefined);
  }
  if (error === 'partial') return new HostProviderError('partial', message);
  return new HostProviderError('failed', message);
}

/** Asks the host for its providers, the models it offers, and the catalog edits. */
export async function getProviders(options: Options = {}): Promise<ProvidersSnapshot> {
  const response = await send(HOST_PROVIDERS_ROUTE, {}, options);
  if (!response.ok) {
    throw new HostProviderError(
      'failed',
      `The host answered ${String(response.status)}.`,
      undefined,
      response.status,
    );
  }
  return providersSchema.parse(await response.json());
}

/**
 * Stores `apiKey` as the provider's key and lists the provider, so its models join the catalog at
 * once. The key travels in this one request; nothing here keeps it.
 *
 * @throws {HostProviderError} When the host refuses the change.
 */
export async function connectProvider(
  provider: string,
  apiKey: string,
  options: MutationOptions = {},
): Promise<void> {
  const mutation = await mutationInput(options);
  const response = await send(
    `${HOST_PROVIDERS_ROUTE}/${encodeURIComponent(provider)}`,
    jsonRequest('PUT', { apiKey, ...mutation }),
    options,
  );
  if (!response.ok) throw await faultOf(response, apiKey);
}

/**
 * Asks the provider whether it accepts `apiKey`, with one request of one token, and stores nothing:
 * a key that fails here is not in use, and the key already saved keeps working. A refused key is a
 * result (`ok: false`), not a failure. Pass `signal` to stop the request when the person cancels.
 *
 * @throws {HostProviderError} When the host cannot make the test; an abort is thrown as it is.
 */
export async function testProviderKey(
  provider: string,
  apiKey: string,
  options: Options = {},
): Promise<ProviderKeyTest> {
  const response = await send(
    `${HOST_PROVIDERS_ROUTE}/${encodeURIComponent(provider)}/test`,
    jsonRequest('POST', { apiKey }),
    options,
  );
  if (!response.ok) throw await faultOf(response, apiKey);
  return keyTestSchema.parse(await response.json());
}

/**
 * Removes the provider's key, so its models leave the catalog and no later run can call it. The
 * host keeps the provider's allowlist and the catalog edits for a later connect.
 *
 * @throws {HostProviderError} When the host refuses the change.
 */
export async function disconnectProvider(
  provider: string,
  options: MutationOptions = {},
): Promise<void> {
  const mutation = await mutationInput(options);
  const response = await send(
    `${HOST_PROVIDERS_ROUTE}/${encodeURIComponent(provider)}`,
    jsonRequest('DELETE', mutation),
    options,
  );
  if (!response.ok) throw await faultOf(response);
}

/**
 * Replaces the catalog edits in `configuration.json`, which the Bureau's model catalog takes at
 * once (`bureau.models.replace`) and a restart reads again.
 *
 * `base` is the list of edits the person started from. The host compares it with the edits it
 * stores, under its configuration queue, and refuses a save whose base differs.
 *
 * @throws {HostProviderError} When the host refuses the edits; `kind` is `conflict` when the
 * catalog changed after the page read it.
 */
export async function replaceCatalogEdits(
  edits: readonly CatalogEdit[],
  options: MutationOptions & { readonly base?: readonly CatalogEdit[] } = {},
): Promise<void> {
  const { base, ...rest } = options;
  const captured = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(JSON.stringify({ edits, ...(base === undefined ? {} : { base }) })));
  const mutation = await mutationInput(options);
  const response = await send(
    HOST_CATALOG_ROUTE,
    jsonRequest('PUT', { ...captured, ...mutation }),
    rest,
  );
  if (!response.ok) throw await faultOf(response);
}

/**
 * Reads `configuration.json` and the keys again, for a person who edited them by hand.
 *
 * @throws {HostProviderError} When the host cannot read them.
 */
export async function reloadProviders(options: Options = {}): Promise<void> {
  const response = await send(HOST_PROVIDERS_RELOAD_ROUTE, { method: 'POST' }, options);
  if (!response.ok) throw await faultOf(response);
}
