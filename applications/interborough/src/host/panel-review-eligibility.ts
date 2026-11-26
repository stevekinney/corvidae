import type { Principal } from '@lostgradient/backchannel';
import type { HostAuthority } from './host-authority.ts';
import type { PanelReviewEligibility } from './panel-routes.ts';
import type { createSharedBrowserSignIn } from './shared-browser-sign-in.ts';

/** Reverify browser credentials and their write proof before an in-process panel call. */
function createPanelBrowserCredentials(options: {
  principal(request: Request): Promise<Principal | undefined>;
  validWrite(request: Request): Promise<boolean>;
}) {
  return async (request: Request, name: string): Promise<Headers | Response | undefined> => {
    if (request.headers.has('authorization') || request.headers.has('x-api-key')) return undefined;
    const principal = await options.principal(request);
    if (principal?.method !== 'browser-session') return undefined;
    if (name === 'bureau.reviews.resolve' && !(await options.validWrite(request)))
      return new Response('Forbidden', { status: 403 });
    const headers = new Headers();
    for (const headerName of ['host', 'origin', 'cookie', 'x-csrf-token']) {
      const value = request.headers.get(headerName);
      if (value !== null) headers.set(headerName, value);
    }
    return headers;
  };
}

/** Wire the panel bridge to the host's shared browser sign-in, when configured. */
export function sharedPanelBrowserCredentials(
  authenticate: HostAuthority['authenticate'],
  sharedBrowser:
    | {
        browser: Pick<ReturnType<typeof createSharedBrowserSignIn>['browser'], 'validWrite'>;
        publicRequest: ReturnType<typeof createSharedBrowserSignIn>['publicRequest'];
      }
    | undefined,
) {
  if (sharedBrowser === undefined) return undefined;
  return createPanelBrowserCredentials({
    principal: async (request) => {
      const context = await authenticate(request);
      return context instanceof Response ? undefined : context.principal;
    },
    validWrite: (request) =>
      sharedBrowser.browser.validWrite(
        sharedBrowser.publicRequest(
          new Request(request.url, { method: request.method, headers: request.headers }),
        ),
      ),
  });
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
