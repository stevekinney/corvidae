import { principalFromApiKey, type AuthConfig } from '@lostgradient/backchannel';
import type { ApiKeyAuthority } from '@lostgradient/credentials/api-keys';

import { PUBLIC_ORIGIN_VARIABLE } from './environment-configuration.ts';
import { PUBLIC_A2A_PATH_PREFIX, PUBLIC_ASSETS_PATH_PREFIX, rawPathOf } from './request-guard.ts';

/** Keep obsolete deployment credentials outside ordinary secret management. */
export const A2A_API_KEY_SECRET_KEY = 'a2a-api-key';

export const A2A_SUBJECT = 'a2a';
export const A2A_SCOPES = ['bureau.assets:read', 'bureau.assets:write'] as const;

type A2aKeys = {
  hasIssued(): Promise<boolean>;
  verify(presented: string): Promise<ApiKeyAuthority | null>;
};

export async function resolveA2aExposure(
  keys: A2aKeys,
  publicOrigin: URL | undefined,
  warn: (message: string) => void,
) {
  let credentialed = await keys.hasIssued();
  if (publicOrigin !== undefined && !credentialed) {
    throw new Error(
      `${PUBLIC_ORIGIN_VARIABLE} requires a managed A2A key. Issue the first key in local Settings before enabling public A2A.`,
    );
  }

  /** Require managed service authority at public interfaces and assets, independently of Bureau's
   * generic credential admission. On loopback, A2A only becomes private once a key is issued. */
  async function authorize(request: Request): Promise<Response | undefined> {
    const path = rawPathOf(request);
    const publicHost = request.headers.get('host')?.toLowerCase();
    const fromPublic =
      publicOrigin !== undefined &&
      (publicHost === publicOrigin.host ||
        (publicOrigin.port === '' && publicHost === `${publicOrigin.hostname}:443`));
    const a2a = path.startsWith(PUBLIC_A2A_PATH_PREFIX);
    const discovery =
      a2a &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      (path.endsWith('/.well-known/agent-card.json') || path.endsWith('/.well-known/jwks.json'));
    if (discovery || (!a2a && !(fromPublic && path.startsWith(PUBLIC_ASSETS_PATH_PREFIX)))) {
      return undefined;
    }
    credentialed ||= await keys.hasIssued();
    if (!fromPublic && !credentialed) return undefined;
    const apiKey = request.headers.get('x-api-key');
    const authorization = request.headers.get('authorization');
    const bearer = /^Bearer ([^\s]+)$/iu.exec(authorization ?? '')?.[1];
    const presented = authorization === null ? apiKey : apiKey === null ? bearer : undefined;
    if (presented && (await keys.verify(presented)) !== null) return undefined;
    warn(`A2A authentication refused ${request.method} ${path}: unverified credential.`);
    return Response.json(
      { error: 'No valid credentials provided' },
      { status: 401, headers: { 'www-authenticate': 'Bearer' } },
    );
  }

  return {
    publicOrigin,
    credentialed,
    authentication: createA2aAuthentication((presented) => keys.verify(presented), warn),
    authorize,
  };
}

/** Match the durable workspace-scoped verifier on every presented key. */
export function createA2aAuthentication(
  verify: A2aKeys['verify'],
  warn: (message: string) => void,
): AuthConfig {
  return {
    auditSink: (event) => {
      if (event.outcome !== 'failure') return;
      warn(
        `A2A authentication refused ${event.httpMethod} ${event.path}: ${event.reason ?? 'unauthenticated'}.`,
      );
    },
    resolveApiKeyPrincipal: async (presented) => {
      const verified = await verify(presented);
      return verified === null
        ? null
        : principalFromApiKey({ subject: verified.subject, scopes: [...verified.scopes] });
    },
  };
}
