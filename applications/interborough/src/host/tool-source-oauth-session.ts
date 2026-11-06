import type {
  BeforeMcpOAuthTokenRequest,
  McpOAuthStorageState,
  McpOAuthTokenStorage,
} from 'armorer';
import { createHash, randomUUID } from 'node:crypto';
import type {
  TokenStorageFence,
  TokenStorageTurn,
  ToolSourceSecrets,
  ToolSourceVault,
} from './tool-source-vault.ts';

/** A sign-in the host started and is waiting on. */
export type ToolSourceSignIn = {
  /** Encrypted authorization destination retained for retries of the same explicit flow. */
  readonly authorizationUrl?: string;
  /** When the host handed out the authorization URL, in milliseconds since the epoch. */
  readonly startedAt: number;
  /** A digest of the description the sign-in was started for. A callback for another one is refused. */
  readonly revision: string;
};

/** The sign-in an envelope holds, or none when it holds nothing usable. */
export function parseToolSourceSignIn(value: unknown): ToolSourceSignIn | undefined {
  if (
    !record(value) ||
    typeof value['startedAt'] !== 'number' ||
    !Number.isFinite(value['startedAt']) ||
    typeof value['revision'] !== 'string'
  ) {
    return undefined;
  }
  if (value['authorizationUrl'] !== undefined && typeof value['authorizationUrl'] !== 'string')
    return undefined;
  return {
    startedAt: value['startedAt'],
    revision: value['revision'],
    ...(value['authorizationUrl'] === undefined
      ? {}
      : { authorizationUrl: value['authorizationUrl'] }),
  };
}

/** Durable initiating administrator and sign-in generation, kept after callback cleanup. */
export type ToolSourceOAuthBinding = {
  /** Workspace owning the integration. */
  readonly workspaceId: string;
  /** Initiating administrator's directory identity. */
  readonly actorId: string;
  /** Durable resource owner of the initiating administrator. */
  readonly owner: string;
  /** One sign-in generation, never selected by callback input. */
  readonly flowId: string;
};

/** Encrypted receipt fencing one actual token exchange and its one possible nonce retry. */
export type ToolSourceOAuthClaim = {
  /** Unique exchange claim; the nonce retry retains it. */
  readonly id: string;
  /** The admitted grant kind. */
  readonly grantType: 'authorization_code' | 'refresh_token';
  /** SHA-256 of the exact credential admitted by the host. */
  readonly credentialDigest: string;
  /** Zero for the first attempt, one for its sole nonce retry. */
  readonly attempt: 0 | 1;
  /** Durable outcome; uncertain or unfinished states never permit replay. */
  readonly state: 'claimed' | 'nonce-challenge' | 'response' | 'unknown' | 'published';
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Invalid persisted authority fails closed instead of becoming an unbound credential. */
export function parseToolSourceOAuthBinding(value: unknown): ToolSourceOAuthBinding | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new Error('Invalid stored OAuth binding.');
  const { workspaceId, actorId, owner, flowId } = value;
  if (
    typeof workspaceId !== 'string' ||
    !workspaceId ||
    typeof actorId !== 'string' ||
    !actorId ||
    typeof owner !== 'string' ||
    !owner ||
    typeof flowId !== 'string' ||
    !flowId
  )
    throw new Error('Invalid stored OAuth binding.');
  return { workspaceId, actorId, owner, flowId };
}

/** Invalid persisted exchange state never permits another token request. */
export function parseToolSourceOAuthClaim(value: unknown): ToolSourceOAuthClaim | undefined {
  if (value === undefined) return undefined;
  if (
    !record(value) ||
    typeof value['id'] !== 'string' ||
    value['id'].length === 0 ||
    typeof value['credentialDigest'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value['credentialDigest']) ||
    (value['grantType'] !== 'authorization_code' && value['grantType'] !== 'refresh_token') ||
    (value['attempt'] !== 0 && value['attempt'] !== 1) ||
    (value['state'] !== 'claimed' &&
      value['state'] !== 'nonce-challenge' &&
      value['state'] !== 'response' &&
      value['state'] !== 'unknown' &&
      value['state'] !== 'published')
  )
    throw new Error('Invalid stored OAuth claim.');
  return {
    id: value['id'],
    grantType: value['grantType'],
    credentialDigest: value['credentialDigest'],
    attempt: value['attempt'],
    state: value['state'],
  };
}

/** One loader/completion's fenced storage and actual-dispatch admission hook. */
export type ToolSourceOAuthSession = {
  /** Storage fenced to this flow and its admitted exchange. */
  readonly tokenStorage: McpOAuthTokenStorage;
  /** Commit a claim before the SDK can spend a one-use credential. */
  readonly beforeTokenRequest: BeforeMcpOAuthTokenRequest;
};

/** Compose a session only after its binding has been durably established by the host. */
export function createToolSourceOAuthSession(options: {
  readonly vault: ToolSourceVault;
  readonly sourceId: string;
  readonly binding: ToolSourceOAuthBinding;
  readonly authorize: () => Promise<void>;
  readonly fence?: TokenStorageFence;
  readonly turn?: TokenStorageTurn;
}): ToolSourceOAuthSession {
  const { vault, sourceId, authorize, fence, turn } = options;
  const binding = Object.freeze({ ...options.binding });
  let observed: ToolSourceSecrets | undefined;
  let active: ToolSourceOAuthClaim | undefined;
  const refuse = (): never => {
    throw new Error('The OAuth session no longer owns this exchange.');
  };
  const run = <Result>(work: () => Promise<Result>) =>
    turn === 'held' ? work() : vault.exclusive(sourceId, work);
  const matches = (value: ToolSourceOAuthBinding | undefined) =>
    value !== undefined &&
    value.workspaceId === binding.workspaceId &&
    value.actorId === binding.actorId &&
    value.owner === binding.owner &&
    value.flowId === binding.flowId;
  const read = async () => {
    const current = await vault.read(sourceId);
    if (!matches(current.oauthBinding) || (fence !== undefined && !(await fence(current.snapshot))))
      refuse();
    return current;
  };
  const sameClaim = (claim: ToolSourceOAuthClaim | undefined, expected: ToolSourceOAuthClaim) =>
    claim !== undefined &&
    claim.id === expected.id &&
    claim.attempt === expected.attempt &&
    claim.credentialDigest === expected.credentialDigest &&
    claim.grantType === expected.grantType;
  async function write(next: ToolSourceSecrets, reauthorize = false) {
    const oauthWriteId = randomUUID();
    await vault.write(
      sourceId,
      { ...next, oauthWriteId },
      undefined,
      reauthorize ? authorize : undefined,
    );
    const committed = await read();
    if (committed.oauthWriteId !== oauthWriteId) refuse();
    observed = committed;
    return committed;
  }
  const patch = async (
    change: (state: McpOAuthStorageState) => McpOAuthStorageState,
    tokenSave: boolean,
  ) =>
    run(async () => {
      const current = observed ?? (await read());
      if (active !== undefined) {
        if (
          !sameClaim(current.oauthClaim, active) ||
          (current.oauthClaim?.state !== 'response' && current.oauthClaim?.state !== 'published')
        )
          refuse();
      } else if (current.oauthClaim !== undefined && current.oauthClaim.state !== 'published')
        refuse();
      if (tokenSave && active === undefined) refuse();
      const claim =
        tokenSave && active !== undefined
          ? { ...active, state: 'published' as const }
          : current.oauthClaim;
      const committed = await write(
        { ...current, oauth: change({ ...current.oauth }), oauthClaim: claim },
        active === undefined,
      );
      if (active !== undefined) active = committed.oauthClaim;
    });
  return {
    tokenStorage: {
      load: () =>
        run(async () => {
          const current = await read();
          if (
            active !== undefined &&
            active.state !== 'published' &&
            !sameClaim(current.oauthClaim, active)
          )
            refuse();
          if (
            current.oauthClaim !== undefined &&
            current.oauthClaim.state !== 'published' &&
            (active === undefined || !sameClaim(current.oauthClaim, active))
          )
            refuse();
          if (active?.state === 'published') active = undefined;
          observed = current;
          return structuredClone(current.oauth ?? {});
        }),
      save: (input) => {
        const value = structuredClone(input);
        return patch((state) => ({ ...state, ...value }), value.tokens !== undefined);
      },
      clear: (input) => {
        const keys = [...input];
        return patch((state) => {
          for (const key of keys) delete state[key];
          return state;
        }, false);
      },
    },
    beforeTokenRequest: (input) => {
      const request = { ...input };
      return run(async () => {
        const current = await read();
        await authorize();
        const credentialDigest = createHash('sha256').update(request.credential).digest('hex');
        if (
          request.grantType === 'refresh_token' &&
          current.oauth?.tokens?.refresh_token !== request.credential
        )
          refuse();
        const previous = current.oauthClaim;
        const retry =
          active !== undefined &&
          previous?.id === active.id &&
          previous.state === 'nonce-challenge' &&
          previous.attempt === 0 &&
          previous.credentialDigest === credentialDigest &&
          previous.grantType === request.grantType;
        if (previous !== undefined && previous.state !== 'published' && !retry) refuse();
        if (
          request.grantType === 'authorization_code' &&
          previous?.grantType === request.grantType &&
          previous.credentialDigest === credentialDigest &&
          !retry
        )
          refuse();
        if (active !== undefined && active.state !== 'published' && !retry) refuse();
        const claim: ToolSourceOAuthClaim = {
          id: retry && previous !== undefined ? previous.id : randomUUID(),
          grantType: request.grantType,
          credentialDigest,
          attempt: retry ? 1 : 0,
          state: 'claimed',
        };
        await write({ ...current, oauthClaim: claim }, true);
        active = claim;
        // Claim publication is not the token dispatch: revocation during its CAS still refuses fetch.
        await authorize();
        return {
          settle: (outcome) =>
            run(async () => {
              const latest = await read();
              if (!sameClaim(latest.oauthClaim, claim) || latest.oauthClaim?.state !== 'claimed')
                refuse();
              const state =
                outcome === 'nonce-challenge' && claim.attempt === 0
                  ? 'nonce-challenge'
                  : outcome === 'unknown'
                    ? 'unknown'
                    : 'response';
              const settled: ToolSourceOAuthClaim = { ...claim, state };
              await write({ ...latest, oauthClaim: settled });
              active = settled;
            }),
        };
      });
    },
  };
}
