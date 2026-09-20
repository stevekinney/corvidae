/**
 * Canonical RemoteWorker wire protocol version constants.
 *
 * Lives in a leaf module so both the parser implementation (`protocol.ts`) and
 * the JSON Schema declarations (`protocol-schemas.ts`) can depend on the
 * version without forming an import cycle.
 *
 * @module worker/protocol-version
 */

/**
 * Current RemoteWorker wire protocol version.
 *
 * **Version 5** (Session and Attempt Lease Model, COR-230) splits the single
 * `heartbeat` message's semantics into two independently-clocked messages: a
 * bare `heartbeat` (`workerId` only) renews ONLY the worker-session lease —
 * `WorkerRegistry.heartbeat()` — and a new `activityHeartbeat` (`workerId` +
 * `operationId` + `attemptToken`) renews ONLY that one attempt's
 * heartbeat-extendable visibility deadline, fenced by the same
 * `authorizeTaskResultForCurrentAttempt` identity check `taskResult` already
 * uses. Before v5, a bare `heartbeat` extended the visibility deadline of
 * every in-flight task assigned to the connection — an undocumented fan-out
 * that could not distinguish a live long-running attempt from one the
 * connection no longer actually owned. This is a version bump, not a
 * negotiated one, for the same reason v3's was: a v4 worker's bare
 * heartbeats silently stop keeping its long-running attempts alive against a
 * v5 server (they now renew the session only), which would otherwise regress
 * as a silent task timeout with no diagnostic rather than a clear
 * registration rejection. Every attempt also now carries an absolute
 * `attemptDeadline` (`task-ledger-transitions.ts`) that neither heartbeat
 * kind can extend.
 *
 * **Version 4** (Protocol and Outbox, COR-240) adds the server-to-worker
 * `taskResultAck` message, echoing back the operation's `attemptToken` with a
 * `disposition` of `applied`, `duplicate`, or `dead-lettered`. Pairing this
 * with the worker's outbox re-keyed to `(operationId, attemptToken)` closes
 * the ambiguous-send gap in version 3: a worker no longer discards a buffered
 * result on `WebSocket.send()` returning — only a matching `taskResultAck`
 * does. This is additive to the wire shape (every v3 message still parses
 * unchanged) but is still a version bump, not a negotiated one: version 3
 * peers never receive `taskResultAck` and their outbox never drains without
 * this package's SDK update, so this repository does not carry a second
 * compatibility parser for the retired version.
 *
 * **Version 3** (Canonical Worker Manifest, WFT-27) replaces the register
 * message's parallel top-level identity fields (`activities`, `queue`,
 * `deploymentName`, `buildId`, `runtimeVersion`, `gitSha`, `capabilities`)
 * with a single `manifest: WorkerManifest` field, and the ack echoes
 * `acceptedManifestDigest` plus `serverCapabilities` instead of echoing
 * `activities` back. Both directions of the handshake reshape — a strictly
 * larger change than version 2's same-shape/different-semantics bump — so
 * this is a clean break rather than a negotiated one: a v2 peer gets the
 * canonical `WorkerProtocolIncompatibleError`, not a confusing
 * `invalid_registration`.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_PROTOCOL_VERSION } from '@corvidae/weft';
 *
 * const registration = { type: 'register', protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION };
 * ```
 */
export const REMOTE_WORKER_PROTOCOL_VERSION = 5;

/**
 * Lowest RemoteWorker protocol version accepted by this package.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_MIN_PROTOCOL_VERSION } from '@corvidae/weft';
 *
 * const supportsCurrentVersion = REMOTE_WORKER_MIN_PROTOCOL_VERSION === 5;
 * ```
 */
export const REMOTE_WORKER_MIN_PROTOCOL_VERSION = 5;

/**
 * Highest RemoteWorker protocol version accepted by this package.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_MAX_PROTOCOL_VERSION } from '@corvidae/weft';
 *
 * const canUseRequestedVersion = 5 <= REMOTE_WORKER_MAX_PROTOCOL_VERSION;
 * ```
 */
export const REMOTE_WORKER_MAX_PROTOCOL_VERSION = 5;

/**
 * Explicit supported RemoteWorker protocol versions.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS } from '@corvidae/weft';
 *
 * const supported = REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS.includes(5);
 * ```
 */
export const REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS = [REMOTE_WORKER_PROTOCOL_VERSION] as const;

/**
 * RemoteWorker protocol version accepted by this package.
 *
 * @example
 * ```ts
 * import type { RemoteWorkerProtocolVersion } from '@corvidae/weft';
 *
 * const version: RemoteWorkerProtocolVersion = 5;
 * ```
 */
export type RemoteWorkerProtocolVersion =
  (typeof REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS)[number];
