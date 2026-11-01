<script lang="ts">
  /**
   * The question before a tool source is removed: the agent files that name its tools are listed
   * first, from `GET /host/tool-sources/<id>/affected-agents`, because none of them is edited and
   * each reads invalid when the host starts again until the tool is taken out of it. Cancel
   * changes nothing; Remove clears the source and its credentials.
   */
  import { Alert, Button, Modal, Skeleton } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { CAPABILITIES_COPY } from '../../app/copy.ts';
  import { showFault, showToast } from '../../app/toast-host.svelte';
  import { faultTreatment } from '../../lib/faults.ts';
  import { previewToolSourceRemoval, removeToolSource } from '../../lib/host-tool-sources.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';

  interface Props {
    /** The source the question is about. */
    id: string;
    /** Whether the question is showing. */
    open: boolean;
    onClose: () => void;
    /** Called once the host has removed the source. */
    onRemoved: () => void;
  }

  let { id, open, onClose, onRemoved }: Props = $props();

  const copy = CAPABILITIES_COPY.source.remove;
  const queryClient = useQueryClient();

  const preview = createQuery(
    () => ({
      queryKey: queryKeys.toolSources.removal(id),
      queryFn: ({ signal }) => previewToolSourceRemoval(id, { signal }),
      enabled: open,
      // Read each time the question opens, so it never lists agents from an earlier look.
      staleTime: 0,
      retry: false,
    }),
    undefined,
  );

  const removal = createMutation(() => ({
    mutationFn: () => removeToolSource(id),
    onSuccess: async () => {
      showToast(copy.removed(id));
      await queryClient.invalidateQueries({ queryKey: queryKeys.toolSources.list() });
      onRemoved();
    },
    onError: (error: unknown) => {
      const treatment = faultTreatment(error);
      showFault({ ...treatment, message: `${copy.failed}. ${treatment.message}` });
    },
  }));
</script>

{#if open}
  <Modal open title={copy.title(id)} onDismiss={onClose}>
    {#snippet children()}
      <div class="ib-source-removal" data-testid="source-removal">
        <p class="ib-source-removal__lead">{copy.intro}</p>
        {#if preview.isPending}
          <div role="status" aria-busy="true" aria-label={copy.agentsHeading}>
            <Skeleton height="3rem" />
          </div>
        {:else if preview.isError}
          <Alert variant="warning">{copy.previewFailed}</Alert>
        {:else if preview.data.affectedAgents.length === 0}
          <p class="ib-source-removal__lead" data-testid="source-removal-none">{copy.noAgents}</p>
        {:else}
          <p class="ib-source-removal__lead">{copy.agentsIntro}</p>
          <ul class="ib-source-removal__agents" aria-label={copy.agentsHeading}>
            {#each preview.data.affectedAgents as agent (agent.id)}
              <li class="ib-source-removal__agent" data-affected-agent={agent.id}>
                <a
                  href={router.href(agentPath(agent.id))}
                  onclick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
                      return;
                    }
                    event.preventDefault();
                    onClose();
                    router.navigate(agentPath(agent.id));
                  }}>{agent.name}</a
                >
                <span class="ib-capability__identifier"
                  >{copy.agentTools([...new Set([...agent.tools, ...agent.toolApproval])])}</span
                >
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/snippet}
    {#snippet footer()}
      <Button variant="secondary" onclick={onClose}>{copy.cancel}</Button>
      <Button
        data-changes
        variant="danger"
        loading={removal.isPending}
        disabled={preview.isPending}
        onclick={() => removal.mutate()}>{copy.confirm}</Button
      >
    {/snippet}
  </Modal>
{/if}

<style>
  .ib-source-removal {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-source-removal__lead {
    margin: 0;
  }

  .ib-source-removal__agents {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-source-removal__agent {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    padding: var(--cinder-space-2) 0;
    border-top: 1px solid var(--cinder-border-muted);
    overflow-wrap: anywhere;
  }
</style>
