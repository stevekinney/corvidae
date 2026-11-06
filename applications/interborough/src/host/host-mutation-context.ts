import type { WorkspaceIdentity } from '@lostgradient/weft';
import { createHash, randomUUID } from 'node:crypto';
import { localWorkspaceMembership } from './workspace-principal.ts';
import type { SecretHome } from './workspace-secrets.ts';

/** A refused request never exposes credentials or backend errors in its message. */
export class HostMutationError extends Error {
  constructor(
    /** Stable transport refusal category. */
    readonly code: 'invalid' | 'forbidden' | 'conflict',
  ) {
    super(
      code === 'invalid'
        ? 'A bounded operation ID and configuration revision are required.'
        : code === 'forbidden'
          ? 'Current workspace administration is required.'
          : 'The configuration changed. Reload before starting a new operation.',
    );
  }
}

/** The caller's retry identity and the configuration version it edited. */
export type HostMutationInput = {
  /** Explicit idempotency identity retained across retries of one request. */
  readonly operationId: string;
  /** Opaque revision the caller edited, or explicit absence. */
  readonly expectedRevision: string | null;
};

/** Trusted identity pinned at admission and checked again at the actual write. */
export type HostMutationContext = HostMutationInput & {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly owner: string;
  operationIdFor(scope: string, target: string): string;
  revalidate(): Promise<WorkspaceIdentity>;
};

/** Validate transport input without accepting any caller-supplied actor or workspace. */
export function parseHostMutationInput(
  input: Readonly<Record<string, unknown>>,
): HostMutationInput {
  const operationId = input['operationId'];
  const expectedRevision = input['expectedRevision'];
  if (
    typeof operationId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId) ||
    !(
      expectedRevision === null ||
      (typeof expectedRevision === 'string' &&
        expectedRevision.length > 0 &&
        expectedRevision.length <= 4096)
    )
  ) {
    throw new HostMutationError('invalid');
  }
  return Object.freeze({ operationId, expectedRevision });
}

/** Build authority only from a server-resolved identity and a current membership resolver. */
export function createHostMutationContext(
  identity: WorkspaceIdentity,
  input: HostMutationInput,
  resolve: () => Promise<WorkspaceIdentity | undefined>,
): HostMutationContext {
  if (!identity.capabilities.includes('workspace:manage')) throw new HostMutationError('forbidden');
  const { workspaceId, actorId, owner } = identity;
  const request = parseHostMutationInput(input);
  return Object.freeze({
    ...request,
    workspaceId,
    actorId,
    owner,
    operationIdFor: (scope: string, target: string) =>
      createHash('sha256')
        .update(JSON.stringify([workspaceId, actorId, owner, scope, target, request.operationId]))
        .digest('hex'),
    async revalidate() {
      const current = await resolve();
      if (
        current === undefined ||
        current.workspaceId !== workspaceId ||
        current.actorId !== actorId ||
        current.owner !== owner ||
        !current.capabilities.includes('workspace:manage')
      )
        throw new HostMutationError('forbidden');
      return current;
    },
  });
}

/** Direct in-process calls are explicit local-operator composition, never transport identity. */
export async function createLocalHostMutationContext(
  home: Pick<SecretHome, 'workspaceId' | 'readConfiguration'>,
): Promise<HostMutationContext> {
  const directory = localWorkspaceMembership(home.workspaceId);
  const resolve = async () =>
    (await directory.resolveMembership({ method: 'unauthenticated-local', subject: undefined })) ??
    undefined;
  const identity = await resolve();
  if (identity === undefined) throw new HostMutationError('forbidden');
  const snapshot = await home.readConfiguration();
  return createHostMutationContext(
    identity,
    { operationId: randomUUID(), expectedRevision: snapshot.revision },
    resolve,
  );
}
