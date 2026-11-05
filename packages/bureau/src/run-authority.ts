import type {
  ContentSourceResolver,
  RunOptions,
  SessionInputPayload,
} from '@lostgradient/operative';
import {
  freezeToolRequestContext,
  readRunWorkspaceAuthority,
  type RunWorkspaceAuthority,
  type ToolRequestContext,
} from 'armorer';

import {
  principalFromApiKey,
  principalFromUnauthenticatedLocal,
  type AuthenticatedPrincipal,
} from '@lostgradient/weft';

import { BUREAU_SCOPES, type BureauScope } from './http/bureau-scopes.ts';
import { mayAccessOwnedResource } from './http/owner-predicate.ts';
import {
  resolveWorkspaceOwner,
  type WorkspaceRuntimeAuthority,
} from './http/workspace-principal.ts';
import { ANONYMOUS_LOCAL_OWNER } from './owner-of-record.ts';

/** Builds the transport principal represented by a Bureau run's owner record. */
export function createRunPrincipal(owner: string | undefined): AuthenticatedPrincipal {
  if (owner === ANONYMOUS_LOCAL_OWNER) {
    const local = principalFromUnauthenticatedLocal();
    const scopes = new Set([...local.scopes, ...BUREAU_SCOPES]);
    return Object.freeze({
      ...local,
      scopes,
      hasScope: (scope: Parameters<typeof local.hasScope>[0]) => scopes.has(scope),
      owner: ANONYMOUS_LOCAL_OWNER,
    });
  }
  if (owner?.startsWith('api-key:')) {
    const principal = principalFromApiKey({ subject: owner.slice('api-key:'.length), scopes: [] });
    return Object.freeze({ ...principal, owner });
  }
  const principal = principalFromApiKey({ subject: owner ?? '', scopes: [] });
  return Object.freeze({ ...principal, owner });
}

/** Whether a run may use an operation against a resource. */
export type RunAccessOptions = {
  /** Whether the operation's scope may authorize access to a foreign owner. */
  readonly allowOperatorScope?: boolean;
};

/** Answers a run's scope or owner-equality authorization request. */
export function mayRunAccess(
  owner: string | undefined,
  operationScope: BureauScope,
  resourceOwner?: string,
  options: RunAccessOptions = {},
): boolean {
  if (options.allowOperatorScope === false) return owner !== undefined && owner === resourceOwner;
  const principal = createRunPrincipal(owner);
  return mayAccessOwnedResource({ principal, resourceOwner, operatorScope: operationScope });
}

/** Run tools use current directory roles; the agent's tool catalog remains the action grant. */
export async function mayRunUseSharedConfiguration(
  workspace: WorkspaceRuntimeAuthority | undefined,
  owner: string | undefined,
  operationScope: BureauScope,
  administrator: boolean,
  resourceOwner?: string,
  options: RunAccessOptions = {},
): Promise<boolean> {
  if (workspace === undefined) return mayRunAccess(owner, operationScope, resourceOwner, options);
  if (owner === undefined) return false;
  const membership = await resolveWorkspaceOwner(workspace, owner);
  return (
    membership !== undefined &&
    membership.actorKind !== 'service' &&
    (!administrator || membership.capabilities.includes('workspace:manage'))
  );
}

/** Capture the trusted directory identity before a new durable run or schedule is persisted. */
export async function captureRunWorkspaceAuthority(
  workspace: WorkspaceRuntimeAuthority,
  owner: string,
): Promise<RunWorkspaceAuthority | undefined> {
  const membership = await resolveWorkspaceOwner(workspace, owner);
  if (membership === undefined) return undefined;
  return Object.freeze({
    version: 1,
    workspaceId: membership.workspaceId,
    actorId: membership.actorId,
    authorizingOwner: owner,
    membershipRevision: membership.membershipRevision,
  });
}

/** Evaluate at actual dispatch; a historical revision is evidence, never an enduring grant. */
export async function validateRunWorkspaceAuthority(
  workspace: WorkspaceRuntimeAuthority,
  value: unknown,
): Promise<RunWorkspaceAuthority | undefined> {
  const recorded = readRunWorkspaceAuthority(value);
  if (recorded === undefined || recorded.workspaceId !== workspace.workspaceId) return undefined;
  const current = await captureRunWorkspaceAuthority(workspace, recorded.authorizingOwner);
  return current?.actorId === recorded.actorId ? current : undefined;
}

/** Existing local records use only the explicitly configured local membership. */
export async function recoverRunWorkspaceAuthority(
  workspace: WorkspaceRuntimeAuthority,
  value: unknown,
  owner: string | undefined,
): Promise<RunWorkspaceAuthority | undefined> {
  if (value !== undefined) return validateRunWorkspaceAuthority(workspace, value);
  if (owner !== ANONYMOUS_LOCAL_OWNER) return undefined;
  const member = await resolveWorkspaceOwner(workspace, owner);
  if (member?.actorKind !== 'local') return undefined;
  return captureRunWorkspaceAuthority(workspace, owner);
}

/** Compose workspace admission with the existing transport grant, never replacing either. */
export function createRunAuthorityValidator(
  workspace: WorkspaceRuntimeAuthority | undefined,
  transportValidator: ((context: ToolRequestContext) => boolean | Promise<boolean>) | undefined,
): ((context: ToolRequestContext) => Promise<boolean>) | undefined {
  if (workspace === undefined && transportValidator === undefined) return undefined;
  return async (context) => {
    const revision = context.authority.authorizationRevision;
    if (
      revision !== 'bureau:1' &&
      revision !== 'bureau:scheduler:1' &&
      !(await transportValidator?.(context))
    )
      return false;
    return (
      workspace === undefined ||
      (await recoverRunWorkspaceAuthority(
        workspace,
        context.authority.workspace,
        context.authority.ownerId,
      )) !== undefined
    );
  };
}

/** Bind a fresh run to its authorizing actor before durable admission. */
export async function bindRunWorkspaceAuthority(
  workspace: WorkspaceRuntimeAuthority | undefined,
  context: ToolRequestContext,
  owner: string,
): Promise<ToolRequestContext> {
  if (workspace === undefined) return context;
  const recorded = context.authority.workspace;
  const authority =
    recorded === undefined
      ? await captureRunWorkspaceAuthority(workspace, owner)
      : await validateRunWorkspaceAuthority(workspace, recorded);
  if (authority === undefined) throw new Error('Workspace authority unavailable.');
  return freezeToolRequestContext({
    ...context,
    authority: { ...context.authority, workspace: authority },
  });
}

/** Guard the actual provider and tool callbacks for catalog runs and their recovered options. */
export function guardWorkspaceRunOptions(
  workspace: WorkspaceRuntimeAuthority | undefined,
  options: RunOptions,
  context: ToolRequestContext,
): RunOptions {
  if (workspace === undefined) return options;
  const generate = options.generate;
  const inheritedValidation = options.executeOptions?.revalidateAuthority;
  const revalidate = async (
    candidate: ToolRequestContext,
  ): Promise<ToolRequestContext | undefined> => {
    const inherited = inheritedValidation;
    const checked = inherited === undefined ? candidate : await inherited(candidate);
    if (checked === undefined) return undefined;
    const current = await validateRunWorkspaceAuthority(workspace, context.authority.workspace);
    if (current === undefined) return undefined;
    return freezeToolRequestContext({
      ...checked,
      authority: { ...checked.authority, workspace: current },
    });
  };
  return {
    ...options,
    generate: async (input) => {
      if ((await revalidate(context)) === undefined)
        throw new Error('Workspace authority unavailable.');
      return generate(input);
    },
    executeOptions: {
      ...options.executeOptions,
      requestContext: context,
      revalidateAuthority: revalidate,
    },
  };
}

/** A reassigned automation cannot borrow the previous actor's managed media. */
export async function mayUseAutomationInput(
  input: SessionInputPayload,
  resolver: ContentSourceResolver | undefined,
): Promise<boolean> {
  if (typeof input === 'string') return true;
  try {
    for (const [partIndex, part] of input.entries()) {
      if (part.type === 'text' || part.source.kind !== 'managed-asset') continue;
      if (resolver === undefined) return false;
      const resolution = await resolver(part, { messageId: 'automation-input', partIndex });
      if (resolution.outcome === 'unavailable') return false;
    }
    return true;
  } catch {
    return false;
  }
}
