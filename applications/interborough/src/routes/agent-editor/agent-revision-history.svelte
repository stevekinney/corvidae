<script lang="ts">
  /**
   * The versions of an agent that have run, most recently run first. A save does not make a
   * revision: a version appears here once a run starts on it, so the list is the history of what
   * actually ran, and it outlives the agent's file while its runs are retained. The saved
   * versions of the agent, whether or not it ran, are `bureau.agents.versions.list`.
   */
  import { RelativeTime, Skeleton, Table } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
  import { listAgentRevisions } from '../../lib/agent-definitions.ts';
  import { queryKeys } from '../../lib/query.ts';

  interface Props {
    id: string;
  }

  let { id }: Props = $props();

  const copy = AGENT_EDITOR_COPY.revisions;

  const revisions = createQuery(() => ({
    queryKey: queryKeys.agents.revisions(id),
    queryFn: ({ signal }) => listAgentRevisions(id, { signal }),
    refetchOnWindowFocus: false,
    gcTime: 0,
  }));

  /** The short form of a hash, enough to tell two versions apart. */
  const SHORT_HASH_LENGTH = 8;
</script>

<section class="weft-agent-revisions" aria-labelledby="agent-revisions-heading">
  <h2 id="agent-revisions-heading" class="weft-agent-revisions__heading">{copy.heading}</h2>
  <p class="weft-agent-revisions__description">{copy.description}</p>
  {#if revisions.isPending}
    <div role="status" aria-busy="true" aria-label={copy.heading}>
      <Skeleton height="4rem" />
    </div>
  {:else if revisions.isError}
    <p role="alert">{copy.failed}</p>
  {:else if revisions.data.length === 0}
    <p class="weft-agent-revisions__empty" data-testid="agent-revisions-empty">{copy.empty}</p>
  {:else}
    <Table caption={copy.caption} scrollable>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{copy.versionColumn}</Table.HeaderCell>
          <Table.HeaderCell>{copy.lastRunColumn}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each revisions.data as revision (revision.hash)}
          <Table.Row data-testid="agent-revision">
            <Table.Cell
              ><code title={revision.hash}>{revision.hash.slice(0, SHORT_HASH_LENGTH)}</code
              ></Table.Cell
            >
            <Table.Cell><RelativeTime date={revision.lastRunAt} /></Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table>
  {/if}
</section>

<style>
  .weft-agent-revisions {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-inline-size: 48rem;
  }

  .weft-agent-revisions__heading {
    margin: 0;
    font-size: var(--cinder-text-md);
    font-weight: 600;
  }

  .weft-agent-revisions__description,
  .weft-agent-revisions__empty {
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }
</style>
