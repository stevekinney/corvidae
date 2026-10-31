<script lang="ts">
  /**
   * Install control for `<WorkflowRevisionsPanel>` (COR-1464): a JSON
   * textarea submitted to `weft.workflows.revisions.install`. Rendered only
   * for a principal holding `workflows:admin` (no disabled stand-in): an
   * operator without the scope has nothing to do here.
   *
   * The operation is the validator. The console checks only that the text
   * parses as JSON (text that does not never reaches the server) and shows
   * the operation's fault verbatim when it refuses a manifest, in which
   * case nothing is installed. The operation files a manifest under its own
   * `name`; the success banner names it, and says so when it differs from
   * the workflow whose panel is open.
   */
  import { Badge, Button, Textarea } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';

  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { getPrincipalStore } from '../../lib/scopes.svelte.ts';
  import QueryFaultBanner from './query-fault-banner.svelte';
  import { installedRevisionSummary } from './revision-detail-view.ts';

  interface Props {
    workflowName: string;
  }

  let { workflowName }: Props = $props();

  const client = getClient();
  const principal = getPrincipalStore();
  const queryClient = useQueryClient();

  const canInstall = $derived(principal.hasScope('workflows:admin'));

  let manifestText = $state('');
  let notJson = $state(false);

  const installMutation = createMutation<unknown, unknown, unknown>(() => ({
    mutationFn: (manifest) => client.operations['weft.workflows.revisions.install']({ manifest }),
    onSuccess: (record) => {
      manifestText = '';
      const summary = installedRevisionSummary(record);
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.revisions(workflowName) });
      if (summary !== undefined && summary.name !== workflowName) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.revisions(summary.name) });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.registry() });
    },
  }));

  const installed = $derived(
    installMutation.isSuccess ? installedRevisionSummary(installMutation.data) : undefined,
  );

  function submit(): void {
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      notJson = true;
      installMutation.reset();
      return;
    }
    notJson = false;
    installMutation.mutate(manifest);
  }
</script>

{#if canInstall}
  <section class="weft-revision-install" aria-label="Install a revision">
    <h4 class="weft-revision-install__title">Install a revision</h4>
    <Textarea
      id="revision-install-manifest"
      label="Revision manifest (JSON)"
      description="A workflow revision manifest. Weft validates it and installs it durably; installing does not activate it."
      bind:value={manifestText}
      rows={8}
    />
    {#if notJson}
      <p class="weft-revision-install__error" role="alert">
        The text is not valid JSON, so nothing was sent.
      </p>
    {/if}
    <div>
      <Button
        data-changes
        variant="primary"
        size="sm"
        label="Install revision"
        disabled={manifestText.trim().length === 0 || installMutation.isPending}
        loading={installMutation.isPending}
        onclick={submit}
      />
    </div>
    {#if installMutation.isError}
      <QueryFaultBanner error={installMutation.error} />
    {:else if installMutation.isSuccess}
      <div class="weft-revision-install__outcome" role="status">
        <Badge variant="success">Installed</Badge>
        {#if installed === undefined}
          <p>Weft installed the revision.</p>
        {:else}
          <p>
            Installed revision "{installed.revision}" of {installed.name}.
            {#if installed.name !== workflowName}
              It belongs to a different workflow than the one open here, so it is not in this list.
            {/if}
          </p>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .weft-revision-install {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .weft-revision-install__title {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .weft-revision-install__error {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-status-danger-text);
  }

  .weft-revision-install__outcome {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--cinder-text-sm);
  }

  .weft-revision-install__outcome p {
    margin: 0;
  }
</style>
