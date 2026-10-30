/**
 * The host's routes for executable skills (`skill-manager.ts`). What a host discovered is read
 * through `bureau.skills.list`; these routes change it:
 *
 * - `PUT /host/skills/sources/<id>/trust` with `{ "trusted": true }` (or `false`) trusts or stops
 *   trusting a configured source, writes the decision to `configuration.json`, and applies it.
 * - `POST /host/skills/refresh` reads the configuration and the directories again.
 *
 * Every answer is JSON. A change answers 200 with the source, whether it is trusted now, whether
 * anything changed, and the catalog's revision; a refusal because the home is remote answers 403
 * with `reason: "deployment"`; a source the configuration does not list answers 404; a request or
 * configuration that cannot be used answers 400 naming the field; a change that was applied but
 * not recorded in the audit trail answers 500 with `error: "partial"`; anything else answers 500
 * with a message that names no value.
 *
 * @module skill-routes
 */

import { ProviderConfigurationError } from './provider-configuration-error.ts';
import {
  SkillAuditError,
  SkillInputError,
  SkillWriteLockedError,
  type SkillManager,
} from './skill-manager.ts';

/** The route that refreshes the catalog. */
export const HOST_SKILLS_REFRESH_ROUTE = '/host/skills/refresh';

/** The route that decides the trust of the source it names. */
export const HOST_SKILL_TRUST_ROUTE = '/host/skills/sources/:id/trust';

/** The largest request body the skill routes read. */
const MAXIMUM_BODY_BYTES = 16 * 1024;

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
    if (error instanceof SkillWriteLockedError) {
      return Response.json(
        { error: 'locked', reason: error.reason, message: error.message },
        { status: 403 },
      );
    }
    if (error instanceof SkillInputError) {
      return Response.json(
        {
          error: error.kind === 'unknown-source' ? 'not-found' : 'invalid',
          field: error.field,
          message: error.message,
        },
        { status: error.kind === 'unknown-source' ? 404 : 400 },
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
    if (error instanceof SkillAuditError) {
      return Response.json(
        {
          error: 'partial',
          source: error.sourceId,
          trusted: error.trusted,
          message: error.message,
        },
        { status: 500 },
      );
    }
    // Nothing from the failure is repeated: it may hold a path.
    return Response.json(
      { error: 'failed', message: 'The skill configuration could not be changed.' },
      { status: 500 },
    );
  }
}

/** The routes to merge into the host's `routes`. Each runs the guard first. */
export function skillRoutes(manager: SkillManager, refuse: Refuse) {
  return {
    [HOST_SKILL_TRUST_ROUTE]: {
      PUT: (request: Bun.BunRequest<typeof HOST_SKILL_TRUST_ROUTE>) =>
        refuse(request) ??
        respond(async () => {
          const body = await readObject(request);
          return manager.setTrust({ source: request.params.id, trusted: body['trusted'] });
        }),
    },
    [HOST_SKILLS_REFRESH_ROUTE]: {
      POST: (request: Request) => refuse(request) ?? respond(() => manager.refresh()),
    },
  };
}
