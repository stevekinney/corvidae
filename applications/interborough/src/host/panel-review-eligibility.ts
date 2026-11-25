import type { Principal } from '@lostgradient/backchannel';
import type { PanelReviewEligibility } from './panel-routes.ts';

/** Reverify browser credentials and their write proof before an in-process panel call. */
export function createPanelBrowserCredentials(options: {
  principal(request: Request): Promise<Principal | undefined>;
  validWrite(request: Request): Promise<boolean>;
}) {
  return async (request: Request, name: string): Promise<Headers | Response | undefined> => {
    if (request.headers.has('authorization') || request.headers.has('x-api-key')) return undefined;
    if ((await options.principal(request))?.method !== 'browser-session') return undefined;
    if (name === 'bureau.reviews.resolve' && !(await options.validWrite(request)))
      return new Response('Forbidden', { status: 403 });
    const headers = new Headers();
    for (const name of ['host', 'origin', 'cookie', 'x-csrf-token']) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    return headers;
  };
}

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
