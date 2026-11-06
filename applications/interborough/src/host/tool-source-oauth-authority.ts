import type { WorkspaceMembershipOptions } from '@lostgradient/bureau';
import {
  createLocalHostMutationContext,
  HostMutationError,
  type HostMutationContext,
} from './host-mutation-context.ts';
import { secretPublicationDigest } from './secret-publication-digest.ts';
import {
  createToolSourceOAuthSession,
  type ToolSourceOAuthBinding,
  type ToolSourceOAuthSession,
  type ToolSourceSignIn,
} from './tool-source-oauth-session.ts';
import type { TokenStorageFence, TokenStorageTurn, ToolSourceVault } from './tool-source-vault.ts';
import { localWorkspaceMembership } from './workspace-principal.ts';
import type { SecretHome } from './workspace-secrets.ts';

/** Resolve the initiating administrator for every actual exchange, including background refresh. */
export function createToolSourceOAuthAuthority(options: {
  vault: ToolSourceVault;
  home: Pick<SecretHome, 'workspaceId' | 'readConfiguration'>;
  workspace?: WorkspaceMembershipOptions;
}) {
  const { vault, home } = options;
  const directory = options.workspace ?? localWorkspaceMembership(home.workspaceId);
  const authorize = async (binding: ToolSourceOAuthBinding) => {
    const current = await directory.resolveOwnerMembership?.(binding.owner);
    if (
      current == null ||
      current.workspaceId !== binding.workspaceId ||
      current.workspaceId !== home.workspaceId ||
      current.actorId !== binding.actorId ||
      current.owner !== binding.owner ||
      !current.capabilities.includes('workspace:manage')
    )
      throw new HostMutationError('forbidden');
    return current;
  };
  return {
    /** Resolve the durable initiating actor without trusting callback headers. */
    identity: authorize,
    /** Bind an explicit start to its administrator and retry identity before SDK persistence. */
    async begin(
      sourceId: string,
      sourceRevision: string,
      input?: HostMutationContext,
    ): Promise<ToolSourceOAuthBinding> {
      const mutation = input ?? (await createLocalHostMutationContext(home));
      await mutation.revalidate();
      if (mutation.workspaceId !== home.workspaceId) throw new HostMutationError('forbidden');
      const binding: ToolSourceOAuthBinding = {
        workspaceId: mutation.workspaceId,
        actorId: mutation.actorId,
        owner: mutation.owner,
        flowId: mutation.operationIdFor('tool-source-oauth', sourceId),
      };
      await authorize(binding);
      return vault.exclusive(sourceId, async () => {
        const current = await vault.read(sourceId);
        const repeated = current.oauthBinding?.flowId === binding.flowId;
        if (repeated) {
          if (
            current.oauthBinding?.actorId !== binding.actorId ||
            current.oauthBinding.owner !== binding.owner ||
            current.oauthBinding.workspaceId !== binding.workspaceId
          )
            throw new HostMutationError('forbidden');
        }
        if (!repeated && current.snapshot?.revision !== mutation.expectedRevision)
          throw new HostMutationError('conflict');
        const oauth = { ...current.oauth };
        if (!repeated) {
          delete oauth.state;
          delete oauth.codeVerifier;
          if (current.oauthClaim !== undefined && current.oauthClaim.state !== 'published')
            delete oauth.tokens;
        }
        await vault.write(
          sourceId,
          repeated
            ? current
            : {
                ...current,
                oauth,
                oauthBinding: binding,
                oauthClaim: undefined,
                signIn: undefined,
              },
          { text: current.snapshot?.text, revision: mutation.expectedRevision },
          async () => {
            await mutation.revalidate();
            await authorize(binding);
          },
          {
            operationId: binding.flowId,
            requestDigest: secretPublicationDigest({
              operation: 'tool-source-oauth',
              target: sourceId,
              expectedRevision: mutation.expectedRevision,
              payload: { binding, sourceRevision },
            }),
          },
        );
        return binding;
      });
    },
    /** Persist the URL only for the same initiating flow and source revision. */
    async recordSignIn(
      sourceId: string,
      binding: ToolSourceOAuthBinding,
      signIn: ToolSourceSignIn,
      fence: TokenStorageFence,
    ): Promise<void> {
      const saved = { ...signIn };
      await vault.exclusive(sourceId, async () => {
        const current = await vault.read(sourceId);
        if (
          current.oauthBinding?.flowId !== binding.flowId ||
          current.oauth?.state === undefined ||
          !(await fence(current.snapshot))
        )
          throw new HostMutationError('conflict');
        await vault.write(sourceId, { ...current, signIn: saved }, undefined, async () => {
          await authorize(binding);
        });
      });
    },
    /** Attach durable storage and admission to a loader; injected hosts never adopt unbound tokens. */
    async session(
      sourceId: string,
      sourceRevision: string,
      fence: TokenStorageFence,
      turn: TokenStorageTurn = 'take',
      expected?: ToolSourceOAuthBinding,
    ): Promise<ToolSourceOAuthSession> {
      let current = await vault.read(sourceId);
      if (current.oauthBinding === undefined && options.workspace === undefined) {
        // Existing local values retain their explicit single-user owner when first adopted.
        if (turn === 'held') throw new HostMutationError('forbidden');
        await this.begin(sourceId, sourceRevision);
        current = await vault.read(sourceId);
      }
      const binding = current.oauthBinding;
      if (
        binding === undefined ||
        (expected !== undefined &&
          (binding.flowId !== expected.flowId ||
            binding.actorId !== expected.actorId ||
            binding.owner !== expected.owner ||
            binding.workspaceId !== expected.workspaceId))
      )
        throw new HostMutationError('forbidden');
      await authorize(binding);
      return createToolSourceOAuthSession({
        vault,
        sourceId,
        binding,
        fence,
        turn,
        authorize: async () => {
          await authorize(binding);
        },
      });
    },
  };
}
