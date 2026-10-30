/**
 * The host's routes for the model providers (`provider-manager.ts`):
 *
 * - `GET /host/providers` reports each provider, whether it is configured and has a key, and the
 *   catalog edits. It never carries a key.
 * - `PUT /host/providers/<name>` with `{ "apiKey": "...", "models": ["..."] }` connects a
 *   provider, or replaces its key. `models` is optional, and `null` clears the allowlist.
 * - `PUT /host/catalog` with `{ "edits": [...] }` replaces the catalog edits.
 * - `POST /host/providers/reload` reads the configuration and the keys again.
 *
 * Every answer is JSON. A change answers 200 with the providers now offered and the catalog's
 * revision; a refusal because the home is remote answers 403 with `reason: "deployment"`; a
 * request or configuration that cannot be used answers 400 naming the field; anything else
 * answers 500 with a message that names no value. No answer holds an API key, and neither does a
 * log line: the request body is read once, handed to the manager, and dropped.
 *
 * @module provider-routes
 */

import { ProviderConfigurationError } from './provider-configuration-error.ts';
import {
  ProviderInputError,
  ProviderPartialChangeError,
  ProviderWriteLockedError,
  type ProviderManager,
} from './provider-manager.ts';

/** The route that reports the provider configuration. */
export const HOST_PROVIDERS_ROUTE = '/host/providers';

/** The route that edits the catalog. */
export const HOST_CATALOG_ROUTE = '/host/catalog';

/** The route that reads the configuration and the keys again. */
export const HOST_PROVIDERS_RELOAD_ROUTE = '/host/providers/reload';

/** The route that connects the provider it names. */
const HOST_PROVIDER_ROUTE = `${HOST_PROVIDERS_ROUTE}/:name`;

/** The largest request body the provider routes read. */
const MAXIMUM_BODY_BYTES = 256 * 1024;

type Refuse = (request: Request) => Response | undefined;

/** A request body that is not JSON of the expected shape. The message names the body, never its contents. */
class BodyError extends Error {}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAXIMUM_BODY_BYTES) throw new BodyError('The request body is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BodyError('The request body is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BodyError('The request body must be a JSON object.');
  }
  return Object.fromEntries(Object.entries(parsed));
}

/** Run `work` and answer with its result, or with the refusal its error stands for. */
async function respond(work: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await work());
  } catch (error) {
    if (error instanceof ProviderWriteLockedError) {
      return Response.json(
        { error: 'locked', reason: error.reason, message: error.message },
        { status: 403 },
      );
    }
    if (error instanceof ProviderInputError) {
      return Response.json(
        { error: 'invalid', field: error.field, message: error.message },
        { status: 400 },
      );
    }
    if (error instanceof ProviderConfigurationError) {
      return Response.json(
        { error: 'invalid', field: error.field, message: error.message },
        { status: 400 },
      );
    }
    if (error instanceof BodyError) {
      return Response.json(
        { error: 'invalid', field: 'body', message: error.message },
        { status: 400 },
      );
    }
    if (error instanceof ProviderPartialChangeError) {
      return Response.json(
        { error: 'partial', provider: error.provider, message: error.message },
        { status: 500 },
      );
    }
    // Nothing from the failure is repeated: it may hold a path or, from a provider, a value.
    return Response.json(
      { error: 'failed', message: 'The provider configuration could not be changed.' },
      { status: 500 },
    );
  }
}

/** The routes to merge into the host's `routes`. Each runs the guard first. */
export function providerRoutes(manager: ProviderManager, refuse: Refuse) {
  return {
    [HOST_PROVIDERS_ROUTE]: {
      GET: (request: Request) => refuse(request) ?? respond(() => manager.snapshot()),
    },
    [HOST_PROVIDER_ROUTE]: {
      PUT: (request: Bun.BunRequest<typeof HOST_PROVIDER_ROUTE>) =>
        refuse(request) ??
        respond(async () => {
          const body = await readObject(request);
          return manager.connect({
            provider: request.params.name,
            apiKey: body['apiKey'],
            models: body['models'],
          });
        }),
    },
    [HOST_PROVIDERS_RELOAD_ROUTE]: {
      POST: (request: Request) => refuse(request) ?? respond(() => manager.reload()),
    },
    [HOST_CATALOG_ROUTE]: {
      PUT: (request: Request) =>
        refuse(request) ??
        respond(async () => {
          const body = await readObject(request);
          return manager.editCatalog(body['edits']);
        }),
    },
  };
}
