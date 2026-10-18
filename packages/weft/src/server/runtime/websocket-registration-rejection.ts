/**
 * Refusing a worker's `register` message: the rejection log entry and
 * `registerError` frame every gate shares, and the durable deployment-catalog
 * gate that runs after the in-memory digest check.
 *
 * Split out of `websocket-worker-registration.ts` to keep that module under the
 * repository's per-file line ceiling.
 *
 * @module server/runtime/websocket-registration-rejection
 */

import type { ServerWebSocket } from 'bun';

import type { WorkerManifest } from '../../worker/manifest/index.ts';
import type { RegisterErrorMessage, RegisterMessage } from '../../worker/protocol.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import type { ServerContext } from './context.ts';
import { recordDeploymentVersion } from './deployment-version-registration.ts';
import { rejectRegistration } from './websocket-worker-messaging.ts';

/**
 * Record one declined `register` attempt in the registry's bounded rejection
 * log (WFT-29), then send the `registerError` frame and close the socket.
 * `identity` carries whatever deployment fields had already been parsed by
 * the time the calling gate rejected the attempt — most gates run before a
 * `WorkerManifest` exists, so it is usually absent.
 */
export function rejectAndRecordRegistration(
  context: ServerContext,
  ws: ServerWebSocket<WebSocketData>,
  code: RegisterErrorMessage['code'],
  message: string,
  workerId: string | undefined,
  requestedProtocolVersion: number | undefined,
  identity?: { deploymentName?: string; buildId?: string },
): void {
  context.registry.recordRejection({
    code,
    ...(workerId !== undefined ? { workerId } : {}),
    rejectedAt: Date.now(),
    queue: ws.data.queue ?? 'default',
    ...(identity?.deploymentName !== undefined ? { deploymentName: identity.deploymentName } : {}),
    ...(identity?.buildId !== undefined ? { buildId: identity.buildId } : {}),
  });
  rejectRegistration(ws, code, message, requestedProtocolVersion);
}

/**
 * Record the worker's deployment version in the durable catalog before it is
 * accepted. A build whose digest conflicts with a connected worker's is refused
 * first, writing nothing (the registry's guard runs before the catalog is
 * touched). A conflict with the stored version is refused as a
 * `deployment_conflict`; a catalog that cannot be reached closes the socket
 * with 1013 (Try Again Later), the standard retry signal, and the worker
 * reconnects with its usual backoff, never half-registered.
 */
export async function recordVersionOrReject(
  context: ServerContext,
  ws: ServerWebSocket<WebSocketData>,
  message: RegisterMessage,
  manifest: WorkerManifest,
  acceptedManifestDigest: string,
): Promise<boolean> {
  const { name, buildId, artifactDigest } = manifest.deployment;
  if (!context.registry.checkDeploymentConsistency(name, buildId, artifactDigest).ok) {
    // `commitWorkerRegistration` rejects it with the registry's own message and records the rejection.
    return true;
  }
  const recording = await recordDeploymentVersion(context, manifest, acceptedManifestDigest);
  if (recording.ok) return true;
  if (recording.reason === 'conflict') {
    rejectAndRecordRegistration(
      context,
      ws,
      'deployment_conflict',
      `Deployment "${name}" build "${buildId}" is already registered with a different artifact or manifest digest`,
      message.workerId,
      message.protocolVersion,
      { deploymentName: name, buildId },
    );
    return false;
  }
  console.warn(`[weft] ${recording.message}`);
  if (ws.readyState === WebSocket.OPEN) ws.close(1013, 'Deployment catalog unavailable; retry');
  return false;
}
