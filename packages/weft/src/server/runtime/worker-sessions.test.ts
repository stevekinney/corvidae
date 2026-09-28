import { describe, expect, it } from 'bun:test';

import { manifestForActivities } from '../../worker/registry-fixtures.test-support.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';
import { handleWorkerSessionRequest } from './worker-sessions.ts';

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postWorkerSession(body: unknown): Promise<Response> {
  const context = minimalServerContext();
  const options = minimalServeOptions();
  const request = jsonRequest('/v1/worker-sessions', body);
  const response = await handleWorkerSessionRequest(
    context,
    options,
    request,
    new URL(request.url),
  );
  if (response === null) throw new Error('Expected worker-session handler response');
  return response;
}

describe('worker-session runtime handler', () => {
  it('rejects malformed registration fields before mutating the registry', async () => {
    const manifest = manifestForActivities(['checkout.charge']);

    const invalidCases: Array<[body: unknown, expectedError: string]> = [
      [{ manifest: null }, 'Invalid worker manifest'],
      [{ manifest, queue: '../bad' }, 'queue must be a non-empty URL-safe queue name'],
      [{ manifest, concurrency: 0 }, 'concurrency must be a positive safe integer'],
      [{ manifest, startedAt: -1 }, 'startedAt must be a non-negative number'],
      [{ manifest: { ...manifest, protocolVersion: 7 } }, 'Unsupported worker protocol version'],
    ];

    for (const [body, expectedError] of invalidCases) {
      const response = await postWorkerSession(body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: expectedError });
    }
  });

  it('rejects a conflicting deployment artifact digest for the same deployment version', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const firstManifest = manifestForActivities(['checkout.charge'], {
      deployment: { name: 'checkout', buildId: 'b1', artifactDigest: 'sha256:first' },
    });
    const secondManifest = manifestForActivities(['checkout.charge'], {
      deployment: { name: 'checkout', buildId: 'b1', artifactDigest: 'sha256:second' },
    });

    const firstRequest = jsonRequest('/v1/worker-sessions', { manifest: firstManifest });
    const firstResponse = await handleWorkerSessionRequest(
      context,
      options,
      firstRequest,
      new URL(firstRequest.url),
    );
    expect(firstResponse?.status).toBe(200);

    const secondRequest = jsonRequest('/v1/worker-sessions', { manifest: secondManifest });
    const secondResponse = await handleWorkerSessionRequest(
      context,
      options,
      secondRequest,
      new URL(secondRequest.url),
    );
    expect(secondResponse?.status).toBe(409);
    await expect(secondResponse?.json()).resolves.toMatchObject({
      error: 'Deployment artifact digest conflict',
      code: 'deployment_conflict',
    });
  });

  it('accepts a bare session heartbeat without touching attempt lease state', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const registerRequest = jsonRequest('/v1/worker-sessions', {
      manifest: manifestForActivities(['checkout.charge']),
    });
    const registerResponse = await handleWorkerSessionRequest(
      context,
      options,
      registerRequest,
      new URL(registerRequest.url),
    );
    const registerBody = (await registerResponse?.json()) as { sessionId: string };
    const sessionBefore = context.longPollWorkerSessions.get(registerBody.sessionId);
    if (sessionBefore === undefined) throw new Error('Expected registered worker session');

    const heartbeatRequest = jsonRequest(
      `/v1/worker-sessions/${encodeURIComponent(registerBody.sessionId)}/heartbeat`,
      {},
    );
    const heartbeatResponse = await handleWorkerSessionRequest(
      context,
      options,
      heartbeatRequest,
      new URL(heartbeatRequest.url),
    );
    expect(heartbeatResponse?.status).toBe(200);
    await expect(heartbeatResponse?.json()).resolves.toEqual({ ok: true });
    expect(
      context.longPollWorkerSessions.get(registerBody.sessionId)?.lastHeartbeatAt,
    ).toBeGreaterThanOrEqual(sessionBefore.lastHeartbeatAt);
  });

  it('stores a caller-provided startedAt timestamp when registration is accepted', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const startedAt = 123_456;
    const request = jsonRequest('/v1/worker-sessions', {
      manifest: manifestForActivities(['checkout.charge']),
      startedAt,
    });

    const response = await handleWorkerSessionRequest(
      context,
      options,
      request,
      new URL(request.url),
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { sessionId: string };

    expect(context.registry.getWorker(body.sessionId)?.startedAt).toBe(startedAt);
  });
});
