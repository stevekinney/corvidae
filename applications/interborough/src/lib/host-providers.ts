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
  longContext: z
    .object({
      inputTokensAbove: z.number(),
      inputPerMillionTokens: z.number(),
      outputPerMillionTokens: z.number(),
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
  images: z.boolean(),
  pricing: z
    .object({
      inputPerMillionTokens: z.number(),
      outputPerMillionTokens: z.number(),
      currency: z.string(),
    })
    .optional(),
  off: z.boolean(),
});

const providersSchema = z.object({
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

  constructor(kind: HostProviderFaultKind, message: string, field?: string) {
    super(message);
    this.name = 'HostProviderError';
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
  if (error === 'invalid') {
    return new HostProviderError('invalid', message, typeof field === 'string' ? field : undefined);
  }
  if (error === 'partial') return new HostProviderError('partial', message);
  return new HostProviderError('failed', message);
}

/** Asks the host for its providers, the models it offers, and the catalog edits. */
export async function getProviders(options: Options = {}): Promise<ProvidersSnapshot> {
  const response = await send(HOST_PROVIDERS_ROUTE, {}, options);
  if (!response.ok) throw new Error(`The host answered ${response.status}.`);
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
  options: Options = {},
): Promise<void> {
  const response = await send(
    `${HOST_PROVIDERS_ROUTE}/${encodeURIComponent(provider)}`,
    jsonRequest('PUT', { apiKey }),
    options,
  );
  if (!response.ok) throw await faultOf(response, apiKey);
}

/**
 * Replaces the catalog edits in `configuration.json`, which the Bureau's model catalog takes at
 * once (`bureau.models.replace`) and a restart reads again.
 *
 * @throws {HostProviderError} When the host refuses the edits.
 */
export async function replaceCatalogEdits(
  edits: readonly CatalogEdit[],
  options: Options = {},
): Promise<void> {
  const response = await send(HOST_CATALOG_ROUTE, jsonRequest('PUT', { edits }), options);
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
