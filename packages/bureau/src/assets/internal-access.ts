/**
 * What only Bureau's own claim code may do with an asset service (COR-1664), kept off the public
 * `AssetService` surface and off the package index.
 *
 * - **Reserved holders.** A claim held for a session's or a run's row has a holder id Bureau
 *   interprets (`run-row:` and `session-row:`), so the public `retain` refuses them
 *   ({@link AssetReservedHolderError}). Bureau's own claims carry {@link bureauClaim}, a symbol this
 *   module alone exports, which no caller of the package can obtain.
 * - **Claim lookup.** {@link heldClaimsOf} lists claims across every principal, which would show any
 *   caller every asset, owner and holder, so the service registers its lookup here instead of
 *   exposing it. A service that never registered one has none to ask.
 */
import type { AssetHeldClaim, AssetService } from './types';

/** The holder prefixes Bureau interprets, and so reserves. */
export const RESERVED_HOLDER_PREFIXES = ['run-row:', 'session-row:'] as const;

/** Marks a `retain` reference as Bureau's own claim, which may use a reserved holder id. */
export const bureauClaim: unique symbol = Symbol('bureau.claim');

/** Whether a holder id starts with a prefix Bureau reserves. */
export function isReservedHolderId(holderId: string): boolean {
  return RESERVED_HOLDER_PREFIXES.some((prefix) => holderId.startsWith(prefix));
}

type HeldClaimsLookup = (holderPrefix: string) => Promise<readonly AssetHeldClaim[]>;

const lookups = new WeakMap<object, HeldClaimsLookup>();

/** Registers the claim lookup of a service; called once, by the service's own constructor. */
export function exposeHeldClaims(service: AssetService, lookup: HeldClaimsLookup): void {
  lookups.set(service, lookup);
}

/**
 * Every claim whose holder id starts with `holderPrefix`, found from the asset side, for Bureau's
 * reconcilers. Rejects for a service that registered no lookup.
 */
export function heldClaimsOf(
  service: AssetService,
  holderPrefix: string,
): Promise<readonly AssetHeldClaim[]> {
  const lookup = lookups.get(service);
  if (lookup === undefined) {
    return Promise.reject(new Error('This asset service cannot list held claims.'));
  }
  return lookup(holderPrefix);
}
