import { SecretProviderError } from '@lostgradient/bungalow';
import type { HostAuthority } from './host-authority.ts';
import { HostMutationError } from './host-mutation-context.ts';
/**
 * The host's routes for plugins (`plugin-manager.ts`, COR-1880):
 *
 * - `GET /host/plugins` reports each plugin: Bureau's listing (status, problems, contributions),
 *   the owner's persisted `enabled` and `configuration`, the configuration's JSON Schema
 *   (`configurationSchema`, or `null` for a plugin that takes none), what the running host loaded
 *   (`running`, which Revert writes back), whether a restart applies a change, and each declared
 *   secret with whether it is set and where it lives. It never carries a value.
 * - `PUT /host/plugins/<name>` with `{ "enabled": true, "configuration": { ... } }` stores the
 *   owner's choices. Either field may be left out to keep what is stored, and `configuration:
 *   null` removes it.
 * - `PUT /host/plugins/<name>/secrets/<key>` with `{ "value": "..." }` stores a secret the plugin
 *   declared. The value travels in the body, never the path.
 *
 * Every route runs the request guard first, so a page on another origin changes nothing. A change
 * answers 200; a refusal because the home is remote answers 403 with `reason: "deployment"`; an
 * unknown plugin answers 404; a request that cannot be used answers 400 naming the field; anything
 * else answers 500 with a message that names no value. No answer holds a secret's value, and
 * neither does a log line: the body is read once, handed to the manager, and dropped.
 *
 * @module plugin-routes
 */

import { unexpectedJsonRouteFailure } from './json-route-failure.ts';
import type { PluginManager } from './plugin-manager.ts';
import { PluginInputError, PluginNotFoundError, PluginWriteLockedError } from './plugin-manager.ts';
import { ProviderConfigurationError } from './provider-configuration-error.ts';
import { BodyError, readObject } from './provider-routes.ts';

/** The route that reports the plugins. */
export const HOST_PLUGINS_ROUTE = '/host/plugins';

/** The route that stores the choices for the plugin it names. */
const HOST_PLUGIN_ROUTE = `${HOST_PLUGINS_ROUTE}/:name`;

/** The route that stores a secret the plugin it names declared. */
const HOST_PLUGIN_SECRET_ROUTE = `${HOST_PLUGINS_ROUTE}/:name/secrets/:key`;

type Refuse = (request: Request) => Response | undefined;

/** The route parameter, decoded; a malformed escape is the name no plugin has. */
export function decoded(parameter: string): string {
  try {
    return decodeURIComponent(parameter);
  } catch {
    return parameter;
  }
}

/** Run `work` and answer with its result, or with the refusal its error stands for. */
async function respond(
  work: () => Promise<unknown>,
  method: string,
  route: string,
  log?: (message: string) => void,
): Promise<Response> {
  try {
    return Response.json(await work());
  } catch (error) {
    if (error instanceof HostMutationError)
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.code === 'forbidden' ? 403 : error.code === 'conflict' ? 409 : 400 },
      );
    if (error instanceof SecretProviderError) {
      const status =
        error.code === 'rejected'
          ? 400
          : error.code === 'read-only'
            ? 403
            : error.code === 'conflict'
              ? 409
              : 503;
      return Response.json(
        {
          error: 'failed',
          reason: error.code,
          message: 'The secret provider could not complete the operation.',
        },
        { status },
      );
    }
    if (error instanceof PluginWriteLockedError) {
      return Response.json(
        { error: 'locked', reason: error.reason, message: error.message },
        { status: 403 },
      );
    }
    if (error instanceof PluginNotFoundError) {
      return Response.json(
        { error: 'not-found', plugin: error.plugin, message: error.message },
        { status: 404 },
      );
    }
    if (error instanceof PluginInputError || error instanceof ProviderConfigurationError) {
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
    // Nothing from the failure is repeated: it may hold a path or a value.
    return unexpectedJsonRouteFailure({
      log,
      method,
      route,
      message: 'The plugin settings could not be changed.',
    });
  }
}

/** The routes to merge into the host's `routes`. Each runs the guard first. */
export function pluginRoutes(
  manager: PluginManager,
  refuse: Refuse,
  authority: Pick<HostAuthority, 'mutation'>,
  log?: (message: string) => void,
) {
  return {
    [HOST_PLUGINS_ROUTE]: {
      GET: (request: Request) =>
        refuse(request) ?? respond(() => manager.snapshot(), 'GET', HOST_PLUGINS_ROUTE, log),
    },
    [HOST_PLUGIN_ROUTE]: {
      PUT: (request: Bun.BunRequest<typeof HOST_PLUGIN_ROUTE>) =>
        refuse(request) ??
        respond(
          async () => {
            const body = await readObject(request);
            const mutation = await authority.mutation(request, body);
            return manager.update(
              decoded(request.params.name),
              {
                enabled: body['enabled'],
                ...(Object.hasOwn(body, 'configuration')
                  ? { configuration: body['configuration'] }
                  : {}),
              },
              mutation,
            );
          },
          'PUT',
          HOST_PLUGIN_ROUTE,
          log,
        ),
    },
    [HOST_PLUGIN_SECRET_ROUTE]: {
      PUT: (request: Bun.BunRequest<typeof HOST_PLUGIN_SECRET_ROUTE>) =>
        refuse(request) ??
        respond(
          async () => {
            const body = await readObject(request);
            return manager.saveSecret(
              decoded(request.params.name),
              decoded(request.params.key),
              body['value'],
              await authority.mutation(request, body),
            );
          },
          'PUT',
          HOST_PLUGIN_SECRET_ROUTE,
          log,
        ),
    },
  };
}
