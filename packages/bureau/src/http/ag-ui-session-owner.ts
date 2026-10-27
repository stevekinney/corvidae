/**
 * Authorizing the records an AG-UI route uses against their own owner.
 *
 * A thread can be deleted and created again under the same id by another owner, so an owner of
 * record read in one step authorizes nothing about a session read in the next. A route therefore
 * decides from the owner of the record it then uses, and passes that owner on: every later read
 * of the thread's session or of a run answers only for the owner that was authorized, and a
 * record of any other owner is a missing one. This is how `bureau.contexts.get` authorizes
 * (`mayAccessLoadedContext`).
 *
 * @module ag-ui-session-owner
 */

import type { AgentSession } from '@lostgradient/operative';

import { ownerOrLocal } from '../owner-of-record.ts';
import { resolveSessionOwner } from '../session-authority.ts';
import type { BureauContexts } from '../types.ts';

/** A session, and the owner of record the session itself names. */
export type OwnedSession = { readonly session: AgentSession; readonly owner: string };

/** The session with its own owner, or `undefined` for a missing one or one whose owner is unreadable. */
export function ownedSession(session: AgentSession | undefined): OwnedSession | undefined {
  if (session === undefined) return undefined;
  const owner = resolveSessionOwner(session.metadata);
  return owner === undefined ? undefined : { session, owner };
}

/**
 * The thread's session, only when its own owner of record is `owner`. A session another owner
 * created under the same id is a missing one.
 */
export async function readSessionOwnedBy(
  bureau: { readonly contexts: Pick<BureauContexts, 'get'> },
  threadId: string,
  owner: string,
): Promise<AgentSession | undefined> {
  const loaded = ownedSession(await bureau.contexts.get(threadId));
  return loaded?.owner === owner ? loaded.session : undefined;
}

/** Whether the run's own owner, the principal it was created with, is `owner`. */
export function runIsOwnedBy(run: { readonly principal?: string | undefined }, owner: string) {
  return ownerOrLocal(run.principal) === owner;
}
