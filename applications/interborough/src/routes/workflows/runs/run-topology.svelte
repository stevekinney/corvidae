<script lang="ts">
  /**
   * The runs around one run as a small tree in a drawer: the run that started it at the top, then
   * this run and the runs started alongside it, and the runs this one started beneath it. A run is
   * a link to its own page; this run is marked as the current one. It shows what the rail counts,
   * up to the number the page read of each group.
   */
  import { Drawer } from '@lostgradient/cinder';
  import type { WorkflowState } from '@lostgradient/weft';

  import { RUN_RELATED_COPY } from '../../../app/copy.ts';
  import RelatedRunLink from './related-run-link.svelte';
  import type { RelatedRun, RelatedRuns } from './run-related-data.ts';

  interface RunTopologyProps {
    open: boolean;
    readonly workflow: Pick<WorkflowState, 'id' | 'type' | 'status' | 'createdAt'>;
    readonly related: RelatedRuns;
  }

  let { open = $bindable(false), workflow, related }: RunTopologyProps = $props();

  interface TopologyNode {
    readonly key: string;
    readonly run: RelatedRun | undefined;
    readonly depth: number;
    readonly current: boolean;
    /** Set for the line that counts runs the page did not read. */
    readonly more: number;
  }

  /** The tree flattened in reading order: parent, this run, what it started, then its siblings. */
  const nodes = $derived.by((): TopologyNode[] => {
    const self: RelatedRun = {
      id: workflow.id,
      type: workflow.type,
      status: workflow.status,
      createdAt: workflow.createdAt,
    };
    const hasParent = related.parent !== undefined;
    const list: TopologyNode[] = [];
    if (related.parent !== undefined) {
      list.push({ key: related.parent.id, run: related.parent, depth: 0, current: false, more: 0 });
    }
    const level = hasParent ? 1 : 0;
    list.push({ key: self.id, run: self, depth: level, current: true, more: 0 });
    for (const child of related.children.runs) {
      list.push({ key: child.id, run: child, depth: level + 1, current: false, more: 0 });
    }
    const unreadChildren = related.children.total - related.children.runs.length;
    if (unreadChildren > 0) {
      list.push({
        key: 'more-children',
        run: undefined,
        depth: level + 1,
        current: false,
        more: unreadChildren,
      });
    }
    for (const sibling of related.siblings.runs) {
      list.push({ key: sibling.id, run: sibling, depth: level, current: false, more: 0 });
    }
    const unreadSiblings = related.siblings.total - related.siblings.runs.length;
    if (unreadSiblings > 0) {
      list.push({
        key: 'more-siblings',
        run: undefined,
        depth: level,
        current: false,
        more: unreadSiblings,
      });
    }
    return list;
  });
</script>

<Drawer bind:open title={RUN_RELATED_COPY.topologyTitle} size="md">
  <p class="ib-topology__intro">{RUN_RELATED_COPY.topologyDescription}</p>
  <ul class="ib-topology" aria-label={RUN_RELATED_COPY.topologyTitle} data-testid="run-topology">
    {#each nodes as node (node.key)}
      <li
        class="ib-topology__node"
        style={`--ib-topology-depth: ${node.depth}`}
        data-depth={node.depth}
        data-current={node.current ? '' : undefined}
      >
        {#if node.run !== undefined}
          <RelatedRunLink run={node.run} />
          {#if node.current}
            <span class="ib-topology__current">{RUN_RELATED_COPY.thisRun}</span>
          {/if}
        {:else}
          <span class="ib-topology__more">{RUN_RELATED_COPY.more(node.more)}</span>
        {/if}
      </li>
    {/each}
  </ul>
</Drawer>

<style>
  .ib-topology__intro {
    margin: 0 0 var(--cinder-space-4);
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }

  .ib-topology {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
    min-width: 0;
  }

  .ib-topology__node {
    min-width: 0;
    padding-inline-start: calc(var(--ib-topology-depth) * var(--cinder-space-6));
  }

  .ib-topology__node:not([data-depth='0']) {
    border-inline-start: 1px solid var(--cinder-border-muted);
    margin-inline-start: calc((var(--ib-topology-depth) - 1) * var(--cinder-space-6));
    padding-inline-start: var(--cinder-space-3);
  }

  .ib-topology__node[data-current] {
    font-weight: 600;
  }

  .ib-topology__current {
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-subtle);
  }

  .ib-topology__more {
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }
</style>
