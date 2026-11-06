/**
 * Who this session is and what it may do through Interborough's own API (`/host/session`,
 * `src/host/api-routes.ts`). The host decides the scopes every `/api` operation checks, so the
 * Settings page asks it rather than assuming them. Interborough is single-user for now, so the
 * answer is the person at the keyboard, holding every scope.
 */
import { z } from 'zod';

import { API_SCOPES } from './api-scopes.ts';
import type { Fetcher } from './bureau-client.ts';

/** The route the host answers with {@link HostSession}. */
export const HOST_SESSION_ROUTE = '/host/session';

const hostSessionSchema = z.object({
  /** The principal the session acts as, which the Bureau records as the owner of what it starts. */
  subject: z.string().min(1),
  /** The scopes of Interborough's API the session holds, in the order the catalog lists them. */
  scopes: z.array(z.enum(API_SCOPES)),
});

/** Who this session is and the scopes of Interborough's API it holds. */
export type HostSession = z.infer<typeof hostSessionSchema>;

/** Asks the host who this session is and what it may do. */
export async function getHostSession(options?: {
  readonly signal?: AbortSignal;
  readonly fetch?: Fetcher;
}): Promise<HostSession> {
  const send = options?.fetch ?? fetch;
  const response = await send(
    HOST_SESSION_ROUTE,
    options?.signal === undefined ? undefined : { signal: options.signal },
  );
  if (!response.ok) {
    throw Object.assign(new Error(`The host answered ${response.status}.`), {
      status: response.status,
    });
  }
  return hostSessionSchema.parse(await response.json());
}
