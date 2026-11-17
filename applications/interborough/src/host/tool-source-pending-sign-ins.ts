/**
 * Sign-ins for a tool source that is not saved yet (COR-2436, owner decision 2026-11-17): Connect
 * tools signs in to an MCP OAuth server before the person saves the source, and the save takes the
 * tokens the sign-in got by reference.
 *
 * - **A pending sign-in is a record in memory, never on disk.** It holds its owner (the
 *   administrator who started it: workspace, actor, owner, and a flow id), the source description
 *   it began for (by digest), the `state` value the host generated, the OAuth state the exchange
 *   needs (registered client, PKCE verifier, discovery) and, once it succeeds, the tokens. Nothing
 *   is written anywhere until a save commits the source, so a restart cancels every sign-in in
 *   progress: the person signs in again.
 * - **Bounded and expiring.** At most {@link MAXIMUM_PENDING_SIGN_INS} records, the oldest dropped
 *   first; a callback is taken only within the sign-in window of the start, and a save only within
 *   the same window of the success. Older records are dropped whenever the registry is used.
 * - **Single use.** One callback settles a record (succeeded, canceled or refused); a second
 *   callback for it is refused. The token exchange is admitted once. A save takes a succeeded
 *   record once: a retry of that save, under the same operation id, takes it again, as its receipt
 *   says; any other save is refused.
 * - **Bound to its initiator and its state.** The callback is matched by the `state` value, which
 *   only the host generated, compared in constant time; the record's owner must still be an
 *   administrator of the workspace, and a save, a probe or a read of the outcome is answered only
 *   for the owner who started it. A record of someone else reads as no record.
 * - **No token leaves.** Neither the reference handed to the page, nor the outcome, nor any error
 *   carries a token, a code, a verifier or the provider's own words: a refusal is one of a closed
 *   set of reasons ({@link PendingSignInReason}).
 *
 * @module tool-source-pending-sign-ins
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { McpOAuthStorageState, McpOAuthTokenStorage } from 'armorer';
import type { ToolSourceDescription } from 'armorer/tool-sources';

import type { ToolSourceOAuthBinding } from './tool-source-oauth-session.ts';

/** The most sign-ins in progress the host keeps at once; the oldest is dropped first. */
export const MAXIMUM_PENDING_SIGN_INS = 32;

/** Where a pending sign-in stands. */
export type PendingSignInOutcome = 'waiting' | 'succeeded' | 'canceled' | 'refused' | 'expired';

/**
 * Why a sign-in did not succeed, in a closed set a page words: `denied` (the person declined at
 * the provider), one of the provider's own OAuth error codes (RFC 6749 4.1.2.1), `provider-error`
 * for any other code, `exchange-failed` (the code could not be exchanged for tokens),
 * `not-allowed` (the person who started it may no longer manage the workspace), `expired`, and
 * `used` (a second callback for a sign-in already settled).
 */
export type PendingSignInReason =
  | 'denied'
  | 'invalid_request'
  | 'unauthorized_client'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'provider-error'
  | 'exchange-failed'
  | 'not-allowed'
  | 'expired'
  | 'used';

const PROVIDER_CODES: readonly PendingSignInReason[] = [
  'invalid_request',
  'unauthorized_client',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
];

/** The reason a provider's `error` code stands for: never the provider's description. */
export function providerReason(code: string): {
  readonly outcome: 'canceled' | 'refused';
  readonly reason: PendingSignInReason;
} {
  if (code === 'access_denied') return { outcome: 'canceled', reason: 'denied' };
  const known = PROVIDER_CODES.find((candidate) => candidate === code);
  return { outcome: 'refused', reason: known ?? 'provider-error' };
}

/** One sign-in in progress. */
export type PendingSignIn = {
  /** The reference the page holds: random, and no secret by itself, since only its owner may use it. */
  readonly id: string;
  /** The identifier the source will be saved under. */
  readonly sourceId: string;
  /** The description the sign-in began for: credentials named, never held. */
  readonly source: ToolSourceDescription;
  /** A digest of the description the sign-in began for. */
  readonly revision: string;
  /** Who started it. */
  readonly binding: ToolSourceOAuthBinding;
  /** The origin of the page that started it: the only place its outcome is posted to. */
  readonly openerOrigin: string;
  /** When it started, in milliseconds since the epoch. */
  readonly startedAt: number;
  /** The `state` the host generated and the authorization URL carries. */
  readonly state: string;
  /** The OAuth state the exchange needs, and the tokens once it succeeds. */
  storage: McpOAuthStorageState;
  /** Where it stands. */
  outcome: PendingSignInOutcome;
  /** Why it did not succeed. */
  reason?: PendingSignInReason;
  /** When it settled. */
  settledAt?: number;
  /** Whether a callback took it: the next one is refused, even while the first still exchanges. */
  callbackTaken: boolean;
  /** Whether its one token exchange was admitted. */
  exchanged: boolean;
  /** The operation id of the save that took it. */
  consumedBy?: string;
};

/** A new reference or state value: 32 random bytes, URL-safe. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Whether `given` is `expected`, compared in constant time whatever their lengths. */
export function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** Whether `binding` names the same administrator as `identity`. */
export function sameOwner(
  binding: ToolSourceOAuthBinding,
  identity: { readonly workspaceId: string; readonly actorId: string; readonly owner: string },
): boolean {
  return (
    binding.workspaceId === identity.workspaceId &&
    binding.actorId === identity.actorId &&
    binding.owner === identity.owner
  );
}

/** The OAuth state a save stores: the tokens and the client, never the one-use `state` or verifier. */
export function savedOAuthState(record: PendingSignIn): McpOAuthStorageState {
  const { state: _state, codeVerifier: _verifier, ...kept } = structuredClone(record.storage);
  return kept;
}

/** The token storage of a pending sign-in: in memory, on its record. */
export function pendingTokenStorage(record: PendingSignIn): McpOAuthTokenStorage {
  return {
    load: () => structuredClone(record.storage),
    save: (patch) => {
      record.storage = { ...record.storage, ...structuredClone(patch) };
    },
    clear: (keys) => {
      const next = { ...record.storage };
      for (const key of keys) delete next[key];
      record.storage = next;
    },
  };
}

/** A token storage over a copy of `state`: what a probe with a sign-in uses, which keeps nothing. */
export function copiedTokenStorage(state: McpOAuthStorageState): McpOAuthTokenStorage {
  let held = structuredClone(state);
  return {
    load: () => structuredClone(held),
    save: (patch) => {
      held = { ...held, ...structuredClone(patch) };
    },
    clear: (keys) => {
      for (const key of keys) delete held[key];
    },
  };
}

/** The registry of sign-ins in progress. */
export type PendingSignIns = {
  /** Keep `record`, dropping the oldest when the registry is full. */
  add(record: PendingSignIn): void;
  /** The record `id` refers to, when it is still kept. */
  get(id: string): PendingSignIn | undefined;
  /** The record of source `sourceId` whose `state` is `state`, when one is kept. */
  byState(sourceId: string, state: string): PendingSignIn | undefined;
};

/**
 * The registry, with `now` the clock and `window` the sign-in window: a record is dropped once
 * twice the window has passed since it started, by then neither its callback nor its save is
 * taken.
 */
export function createPendingSignIns(now: () => number, window: number): PendingSignIns {
  const records = new Map<string, PendingSignIn>();
  const prune = (): void => {
    const time = now();
    for (const [id, record] of records) {
      if (!(time - record.startedAt <= 2 * window)) records.delete(id);
    }
  };
  return {
    add(record) {
      prune();
      while (records.size >= MAXIMUM_PENDING_SIGN_INS) {
        const oldest = records.keys().next();
        if (oldest.done === true) break;
        records.delete(oldest.value);
      }
      records.set(record.id, record);
    },
    get(id) {
      prune();
      return records.get(id);
    },
    byState(sourceId, state) {
      prune();
      let found: PendingSignIn | undefined;
      // Every record is compared, so the time taken says nothing of which one matched.
      for (const record of records.values()) {
        const matches = sameSecret(state, record.state);
        if (matches && record.sourceId === sourceId) found = record;
      }
      return found;
    },
  };
}
