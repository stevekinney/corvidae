<script lang="ts">
  /**
   * The saved versions of an agent, newest first (`bureau.agents.versions.list`): each save and
   * each edit made to the file by hand is one, whether or not the agent ran, with what it changed.
   * Restore writes an older version back to the file as a new version, so the list only grows. The
   * newest version is the one the file holds, so it has no Restore.
   *
   * Restore names the hash of the file the page read (`currentHash`), not the version's own hash,
   * so a file that changed since is refused instead of overwritten.
   */
  import { Alert, Badge, Button, EmptyState, SectionHeading, Skeleton } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { AGENT_PAGE_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import {
    agentFaultOf,
    listAgentVersions,
    restoreAgentVersion,
  } from '../../lib/agent-definitions.ts';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';

  interface Props {
    /** The agent's identifier. */
    id: string;
    /** The hash of the file as the page read it, which a restore names. */
    currentHash: string | null;
  }

  let { id, currentHash }: Props = $props();

  const copy = AGENT_PAGE_COPY.versions;
  const queryClient = useQueryClient();

  const versions = createQuery(
    () => ({
      queryKey: queryKeys.agents.versions(id),
      queryFn: ({ signal }) => listAgentVersions(id, { signal }),
      retry: false,
    }),
    undefined,
  );

  let problem = $state<string | null>(null);

  const restore = createMutation(() => ({
    mutationFn: (revision: number) => {
      if (currentHash === null) throw new TypeError('The agent has no file hash to restore over.');
      return restoreAgentVersion(id, revision, currentHash);
    },
    onMutate: () => {
      problem = null;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.versions(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definition(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.revisions(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() });
    },
    onError: (error) => {
      const fault = agentFaultOf(error);
      problem =
        fault.kind === 'rejected' || fault.kind === 'other' ? fault.message : copy.restoreFailed;
      if (fault.kind === 'stale') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definition(id) });
      }
    },
  }));
</script>

<section class="ib-agent-section" aria-label={copy.heading} data-testid="agent-versions">
  <SectionHeading level={2} title={copy.heading} description={copy.description} />
  {#if problem !== null}
    <Alert variant="danger" dismissible onDismiss={() => (problem = null)}>
      <p>{problem}</p>
    </Alert>
  {/if}
  {#if versions.isError}
    <Alert variant="danger">
      <p>{copy.loadFailed}</p>
      <Button variant="secondary" size="sm" onclick={() => void versions.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if versions.isPending}
    <div role="status" aria-busy="true" aria-label={copy.heading}>
      <Skeleton height="4rem" />
    </div>
  {:else if versions.data.length === 0}
    <EmptyState
      kind="first-use"
      size="compact"
      headingLevel={3}
      title={copy.emptyTitle}
      description={copy.emptyDescription}
    />
  {:else}
    <ul class="ib-agent-versions" aria-label={copy.heading}>
      {#each versions.data as version, index (version.revision)}
        <li class="ib-agent-version" data-revision={version.revision}>
          <div class="ib-agent-version__body">
            <span class="ib-agent-version__title">
              {copy.revision(version.revision)}
              {#if index === 0}<Badge variant="accent" size="sm">{copy.current}</Badge>{/if}
            </span>
            <span class="ib-agent-version__meta">
              <time datetime={version.savedAt}
                >{formatRelativeTime(Date.parse(version.savedAt))}</time
              >
              {#if version.savedBy === null}· {copy.savedByHand}{/if}
            </span>
            <span class="ib-agent-version__changed">
              {#if version.changedKeys.length === 0}
                {copy.nothingChanged}
              {:else}
                {copy.changed}:
                {#each keyedByOccurrence(version.changedKeys, (key) => key) as { key, item: changed } (key)}
                  <code>{changed}</code>{' '}
                {/each}
              {/if}
            </span>
          </div>
          {#if index > 0}
            <Button
              data-changes
              variant="secondary"
              size="sm"
              aria-label={copy.restoreLabel(version.revision)}
              disabled={currentHash === null || restore.isPending}
              onclick={() => restore.mutate(version.revision)}>{copy.restoreAction}</Button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
