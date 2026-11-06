import type { FetchLike } from '@modelcontextprotocol/client';

/** Private values at the finalized OAuth token HTTP boundary. Never expose in diagnostics. */
export type McpOAuthTokenRequest = Readonly<{
  grantType: 'authorization_code' | 'refresh_token';
  tokenEndpoint: string;
  credential: string;
}>;

/** A definite response, a proven DPoP nonce challenge, or an uncertain network outcome. */
export type McpOAuthTokenRequestOutcome = 'response' | 'nonce-challenge' | 'unknown';

/** A host-owned claim that must settle before the SDK may consume a token response. */
export type McpOAuthTokenRequestAdmission = {
  /** Persist the outcome; rejection prevents the SDK from accepting the response. */
  settle(outcome: McpOAuthTokenRequestOutcome): void | Promise<void>;
};

/** Claim the exact one-use credential before dispatch; rejection sends no request. */
export type BeforeMcpOAuthTokenRequest = (
  request: McpOAuthTokenRequest,
) => void | McpOAuthTokenRequestAdmission | Promise<void | McpOAuthTokenRequestAdmission>;

async function settleAdmission(
  admission: void | McpOAuthTokenRequestAdmission,
  outcome: McpOAuthTokenRequestOutcome,
): Promise<void> {
  try {
    await admission?.settle(outcome);
  } catch {
    throw new Error('OAuth token request settlement failed.');
  }
}

async function responseOutcome(
  response: Response,
  headers: Headers,
): Promise<McpOAuthTokenRequestOutcome> {
  if (response.status === 400 && headers.has('DPoP')) {
    try {
      const body: unknown = await response.clone().json();
      if (
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        body.error === 'use_dpop_nonce'
      ) {
        return 'nonce-challenge';
      }
    } catch {
      // An unreadable error response cannot establish a definite nonce challenge.
    }
  }
  return 'response';
}

/** Preserve SDK authentication and form construction while fencing every token HTTP attempt. */
export function withOAuthTokenRequestGate(
  fetchFn: FetchLike,
  beforeTokenRequest: BeforeMcpOAuthTokenRequest,
): FetchLike {
  return async (input, init) => {
    if (init?.method?.toUpperCase() !== 'POST' || !(init.body instanceof URLSearchParams)) {
      return fetchFn(input, init);
    }
    const grants = init.body.getAll('grant_type');
    if (!grants.some((grant) => grant === 'authorization_code' || grant === 'refresh_token')) {
      return fetchFn(input, init);
    }
    const grantType = grants[0];
    if (
      grants.length !== 1 ||
      (grantType !== 'authorization_code' && grantType !== 'refresh_token')
    ) {
      throw new Error('Invalid OAuth token request.');
    }
    const credentials = init.body.getAll(
      grantType === 'authorization_code' ? 'code' : 'refresh_token',
    );
    const credential = credentials[0];
    if (credentials.length !== 1 || !credential) throw new Error('Invalid OAuth token request.');
    const tokenEndpoint = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init.headers);
    const requestInit = { ...init, body: new URLSearchParams(init.body), headers };
    const request = Object.freeze({ grantType, tokenEndpoint, credential });
    let admission: void | McpOAuthTokenRequestAdmission;
    try {
      admission = await beforeTokenRequest(request);
    } catch {
      throw new Error('OAuth token request admission failed.');
    }
    let response: Response;
    try {
      response = await fetchFn(tokenEndpoint, requestInit);
    } catch (error) {
      await settleAdmission(admission, 'unknown');
      throw error;
    }
    await settleAdmission(admission, await responseOutcome(response, headers));
    return response;
  };
}
