import type { Principal, VerifiedGrant } from '../http.ts';
export { OAuthStore } from '../oauth-store.ts';
export { hostedOAuth } from './issuer.ts';

/** Configure a resource to advertise and verify an external authorization server. */
export function externalOAuth<T extends Principal>(authority: {
  issuer: string;
  verifyAccessToken(token: string): Promise<VerifiedGrant | null>;
  resolvePrincipal(grant: VerifiedGrant): Promise<T | null>;
}): typeof authority {
  return authority;
}
