/**
 * The records and errors of Bureau hooks (COR-1939): a stored hook, a delivery of one event to it,
 * and the port the signing secrets are kept through.
 *
 * @module hook-types
 */

import type { EncryptedValue } from '@lostgradient/cryptography';

import type { SettingLockReason } from '../settings/settings-schema.ts';

/** A hook: when a published Bureau event of one of `events` happens, its `url` is sent a signed POST. */
export interface Hook {
  /** The hook's identifier, minted by the Bureau. */
  readonly id: string;
  /** The principal that owns the hook: `api-key:<subject>` or `anonymous:local`. Never taken from a payload. */
  readonly owner: string;
  /** A label for the person reading a list; at most 100 characters. */
  readonly name?: string;
  /** Where each delivery is POSTed. See `hook-url-policy.ts` for what a URL may be. */
  readonly url: string;
  /** The published Bureau event kinds the hook fires on; never empty. */
  readonly events: readonly string[];
  /** Whether the hook fires. A disabled hook keeps its secret and its delivery records. */
  readonly enabled: boolean;
  /** Epoch milliseconds the hook was created. */
  readonly createdAt: number;
  /** Epoch milliseconds the hook was last changed. */
  readonly updatedAt: number;
  /** Increases by one on every change; pass it back as `expectedRevision`. */
  readonly revision: number;
}

/** The record under which a hook is stored. */
export interface HookRecord extends Hook {
  /** The stored shape's version. */
  readonly version: 1;
}

/** What one attempt to deliver came to. */
export type HookAttemptOutcome =
  /** The request is being sent; the attempt has no outcome yet. After a restart this means the outcome is unknown. */
  | 'sending'
  /** The receiver answered; `status` says how. */
  | 'response'
  /** The request failed before an answer: a network error, or the timeout. */
  | 'network-error'
  /** The Bureau stopped while the request was in flight, or before its outcome was written. The request may have been received. */
  | 'interrupted'
  /** The URL was refused by the policy at send time; no request was made. */
  | 'refused';

/** One attempt to deliver, in the order made. */
export interface HookDeliveryAttempt {
  /** 1-based; one attempt record produces at most one HTTP request. */
  readonly number: number;
  /** Epoch milliseconds the attempt began. */
  readonly startedAt: number;
  /** Epoch milliseconds the attempt ended; absent while it is `sending`. */
  readonly finishedAt?: number;
  /** How the attempt ended. */
  readonly outcome: HookAttemptOutcome;
  /** The HTTP status, when the receiver answered. */
  readonly status?: number;
  /** The start of the response body, at most {@link HOOK_RESPONSE_EXCERPT_BYTES} bytes. */
  readonly responseExcerpt?: string;
  /** Whether the response body was longer than the excerpt. */
  readonly responseTruncated?: boolean;
  /** Why the attempt failed, with the signing secret removed. */
  readonly error?: string;
}

/** Where a delivery stands. */
export type HookDeliveryStatus =
  /** Not finished; it is retried until it succeeds or runs out of attempts, and resumed after a restart. */
  | 'pending'
  /** The receiver answered with a 2xx status. */
  | 'delivered'
  /** Every attempt failed. */
  | 'exhausted'
  /** The hook was deleted or disabled before the delivery finished. */
  | 'aborted'
  /** The signing secret could not be read, so no request was made. */
  | 'failed-secret';

/** The request a delivery sends, without its signature: the signature is made fresh for each attempt. */
export interface HookDeliveryRequest {
  /** The URL as it was when the delivery was created. */
  readonly url: string;
  /** The headers the signature does not cover; the same on every attempt except `X-Delivery-Attempt`. */
  readonly headers: Readonly<Record<string, string>>;
  /** The exact JSON text sent as the body. */
  readonly body: string;
}

/** A delivery of one event to one hook: the request, every attempt, and where it stands. */
export interface HookDelivery {
  /** The delivery's identifier, also sent as `X-Delivery-Id` and `Idempotency-Key`. */
  readonly id: string;
  /** The hook it belongs to. */
  readonly hookId: string;
  /** The hook's owner; the only principal that reads the record without an operator scope. */
  readonly owner: string;
  /** The event kind delivered, or `hook.test` for a test delivery. */
  readonly kind: string;
  /** Whether this is a `hooks.test` delivery. */
  readonly test: boolean;
  /** Where the delivery stands. */
  readonly status: HookDeliveryStatus;
  /** The request. */
  readonly request: HookDeliveryRequest;
  /** Every attempt made, in order. */
  readonly attempts: readonly HookDeliveryAttempt[];
  /** How many attempts the delivery may make. */
  readonly maxAttempts: number;
  /** Epoch milliseconds the delivery was created. */
  readonly createdAt: number;
  /** Epoch milliseconds the delivery was last changed. */
  readonly updatedAt: number;
}

/** The record under which a delivery is stored. */
export interface HookDeliveryRecord extends HookDelivery {
  /** The stored shape's version. */
  readonly version: 1;
  /** Epoch milliseconds before which another process must not resume the delivery; `0` once released. */
  readonly leaseUntil: number;
  /** Increases by one on every write; every write compares it. */
  readonly revision: number;
}

/** The longest response body kept on an attempt. */
export const HOOK_RESPONSE_EXCERPT_BYTES = 1024;

/**
 * Where a hook's signing secret is kept. Bureau seals the secret before it reaches the port
 * (COR-1816's scheme and `answerEncryption` keys), so a port holds ciphertext only. A host injects
 * its own; without one Bureau keeps the ciphertext in its key-value store.
 */
export interface HookSecretStore {
  /**
   * Why this host refuses to write a hook secret, or `undefined` when it accepts them. A remote
   * Interborough home answers `deployment`: its secrets live in the environment, not here.
   */
  writeLock?(): SettingLockReason | undefined;
  /** The sealed secret of a hook, or `undefined` when there is none. */
  get(hookId: string): Promise<EncryptedValue | undefined>;
  /** Keep a hook's sealed secret, replacing any earlier one. */
  set(hookId: string, encrypted: EncryptedValue): Promise<void>;
  /** Forget a hook's secret. */
  delete(hookId: string): Promise<void>;
}

/** Why a hooks call was refused. */
export type HookErrorCode =
  /** There is no such hook. */
  | 'not-found'
  /** An input is not acceptable; `issues` names the fields. */
  | 'invalid'
  /** `expectedRevision` is not the hook's revision. */
  | 'stale-revision'
  /** The host refuses to write a signing secret; `lockReason` says why. */
  | 'locked'
  /** The Bureau has no `answerEncryption` key, so it cannot seal a secret. */
  | 'no-encryption'
  /** The hook's secret cannot be opened (the key is no longer held), so no delivery can be signed. */
  | 'secret-unavailable';

/** A refused hooks call. */
export class HookError extends Error {
  /** Why the call was refused. */
  readonly code: HookErrorCode;
  /** The fields an `invalid` refusal names. */
  readonly issues: readonly { readonly path: readonly string[]; readonly message: string }[];
  /** The revision now current, for a `stale-revision` refusal. */
  readonly currentRevision: number | undefined;
  /** Why the host locks secret writes, for a `locked` refusal. */
  readonly lockReason: SettingLockReason | undefined;

  constructor(
    code: HookErrorCode,
    message: string,
    details: {
      readonly issues?: HookError['issues'];
      readonly currentRevision?: number;
      readonly lockReason?: SettingLockReason;
    } = {},
  ) {
    super(message);
    this.name = 'HookError';
    this.code = code;
    this.issues = details.issues ?? [];
    this.currentRevision = details.currentRevision;
    this.lockReason = details.lockReason;
  }
}
