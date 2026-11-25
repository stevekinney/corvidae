import type { Principal } from '@lostgradient/backchannel';
import type { PanelReviewEligibility } from './panel-routes.ts';

/** Build eligibility from a verified principal and the current authoritative review. */
export function createPanelReviewEligibility<
  Review extends {
    readonly kind: string;
    readonly status: string;
    readonly round?: number | undefined;
  },
>(options: {
  read(id: string): Promise<Review | undefined>;
  principal(request: Request): Promise<Principal | undefined>;
  isTrustedHuman(principal: Principal, request: Request): boolean | Promise<boolean>;
  isProtected(review: Review): boolean;
  verified(review: Review): Promise<boolean>;
  mayDecide(review: Review, principal: Principal): boolean | Promise<boolean>;
}): PanelReviewEligibility {
  return async (request, id, round, purpose) => {
    const principal = await options.principal(request);
    if (!principal || principal.method === 'unauthenticated') return 'denied';
    const review = await options.read(id);
    if (!review || review.kind !== 'tool-approval' || review.status !== 'pending') return 'denied';
    if (!options.isProtected(review)) return 'ordinary';
    if (purpose === 'read' && review.round !== round) return 'denied';
    if (principal.workspace?.actorKind !== 'user') return 'denied';
    if (!(await options.isTrustedHuman(principal, request))) return 'denied';
    if (!(await options.verified(review))) return 'denied';
    return (await options.mayDecide(review, principal)) ? 'authorized' : 'denied';
  };
}
