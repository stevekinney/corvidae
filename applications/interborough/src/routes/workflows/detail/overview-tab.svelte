<script lang="ts">
  /**
   * Overview tab (plan T2.4/§9.2): `DescriptionList` + `PayloadInspector` for
   * input/result/error, failure-category badge + plain-language explanation,
   * a tag editor (Cinder's `TagInput`; the header only shows tags read-only, see `header.svelte`), and the
   * Lineage panel (T2.7, `lineage-panel.svelte`).
   *
   * ## Revision row (WFT-117)
   *
   * Always rendered (previously omitted entirely for a legacy record with
   * no persisted `revision`) — an operator asking "which revision did this
   * run start against, and does it match what's active now" deserves an
   * explicit answer in every case, not a silently missing row. The
   * definition text folds in the same `classifyRevisionAgainstActive`
   * comparison `header.svelte`'s badge uses, so the two surfaces never
   * disagree about a given run's state.
   */
  import {
    Badge,
    Collapsible,
    DescriptionList,
    PayloadInspector,
    TagInput,
  } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import type { HttpClient, WorkflowState } from '@lostgradient/weft';
  import { CircleX } from '@lucide/svelte';
  import { untrack } from 'svelte';

  import { queryKeys } from '../../../lib/query.ts';
  import { createSerialQueue } from '../../../lib/serial-queue.ts';
  import type { ScopeGate } from '../../../lib/scopes.svelte.ts';
  import AttributesPanel from './attributes/attributes-panel.svelte';
  import type { AttributesClient } from './attributes/attributes-data.ts';
  import {
    classifyRevisionAgainstActive,
    type WorkflowCatalogActivePointerLike,
    type WorkflowActiveRevisionClient,
  } from '../../../lib/workflow-revision.ts';
  import { failureCategoryExplanation, failureCategoryLabel } from './failure-category.ts';
  import LineagePanel from './lineage-panel.svelte';
  import WorkerBindingPanel from './worker-binding-panel.svelte';

  interface OverviewTabProps {
    readonly client: Pick<HttpClient, 'addTags' | 'removeTags' | 'get' | 'list'> & {
      readonly operations: Pick<HttpClient['operations'], 'weft.workflows.scheduleprovenance.get'> &
        WorkflowActiveRevisionClient['operations'] &
        Partial<AttributesClient['operations']>;
    };
    readonly workflow: WorkflowState;
    /**
     * Same `weft.workflows.active.get` result `header.svelte` receives —
     * see that component's module doc. Optional (rather than
     * `header.svelte`'s required-but-possibly-`undefined` prop) purely to
     * keep this component's many existing test call sites from all needing
     * an explicit value — omitting it and passing `undefined` are
     * semantically identical (`classifyRevisionAgainstActive` treats both
     * as "unknown"), so this is a test-ergonomics choice, not a behavior
     * difference from `header.svelte`.
     */
    readonly activeRevision?: WorkflowCatalogActivePointerLike | null | undefined;
    /** Whether the principal holds `tags:write`, which adding and removing tags requires; open when omitted. */
    readonly tagGate?: ScopeGate | undefined;
    /**
     * What the principal may do with the run's search attributes (COR-1461). Omitted, the section does
     * not render; given, it renders only for `canRead`, and offers edits only for `canWrite`.
     */
    readonly attributeAccess?:
      { readonly canRead: boolean; readonly canWrite: boolean } | undefined;
  }

  let {
    client,
    workflow,
    activeRevision,
    tagGate = { disabled: false, title: undefined },
    attributeAccess,
  }: OverviewTabProps = $props();

  const attributesClient = $derived.by((): AttributesClient | undefined => {
    const get = client.operations['weft.workflows.attributes.get'];
    const set = client.operations['weft.workflows.attributes.set'];
    return get === undefined || set === undefined
      ? undefined
      : {
          operations: {
            'weft.workflows.attributes.get': get,
            'weft.workflows.attributes.set': set,
          },
        };
  });

  const REVISION_COMPARISON_SUFFIX: Readonly<Record<'active' | 'stale' | 'unknown', string>> = {
    active: ' — active',
    stale: ' — differs from active',
    unknown: ' — active revision unknown',
  };

  const revisionComparison = $derived(
    classifyRevisionAgainstActive(workflow.revision, activeRevision),
  );

  const queryClient = useQueryClient();

  function invalidateDetail(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.detail(workflow.id) });
  }

  // Each change the editor reports is one write per tag. The writes go through one queue, in the order
  // they were made, and each starts once the one before it has settled: an add and a remove of the same
  // tag sent independently can land in either order, and a late add then durably restores a tag the
  // person removed. The page reads the tags again once the queue is empty, whatever the engine
  // answered, so a write that failed puts the field back to what the engine holds; reading between
  // two queued writes would show the engine's half-way state.
  const tagWrites = createSerialQueue();
  function invalidateWhenWritesHaveSettled(): void {
    if (tagWrites.pending === 0) invalidateDetail();
  }
  const addTagMutation = createMutation(() => ({
    mutationFn: (tag: string) => {
      const id = workflow.id;
      return tagWrites.run(() => client.addTags(id, tag));
    },
    onSettled: invalidateWhenWritesHaveSettled,
  }));
  const removeTagMutation = createMutation(() => ({
    mutationFn: (tag: string) => {
      const id = workflow.id;
      return tagWrites.run(() => client.removeTags(id, tag));
    },
    onSettled: invalidateWhenWritesHaveSettled,
  }));

  // `requested` is the list the engine was last asked for, so a change is the difference from it and
  // not from the tags the engine last answered with: two quick edits before the engine answers each
  // send their own write, and a tag added and removed in between is not lost.
  let tags = $state<string[]>(untrack(() => [...(workflow.tags ?? [])]));
  let requested: readonly string[] = untrack(() => [...(workflow.tags ?? [])]);
  $effect(() => {
    tags = [...(workflow.tags ?? [])];
    requested = [...(workflow.tags ?? [])];
  });

  function changeTags(next: string[]): void {
    const before = requested;
    requested = [...next];
    for (const tag of next.filter((candidate) => !before.includes(candidate))) {
      addTagMutation.mutate(tag);
    }
    for (const tag of before.filter((candidate) => !next.includes(candidate))) {
      removeTagMutation.mutate(tag);
    }
  }

  const errorStack = $derived(workflow.errorStack ?? '');

  const versionSummaryText = $derived(
    [
      `wf ${workflow.versionTuple.workflowVersion}`,
      workflow.versionTuple.agentVersion ? `agent ${workflow.versionTuple.agentVersion}` : null,
      workflow.versionTuple.toolVersions && workflow.versionTuple.toolVersions.length > 0
        ? `tools ${workflow.versionTuple.toolVersions.length}`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' · '),
  );

  const definitionItems = $derived([
    { id: 'type', term: 'Type', definition: typeDefinition },
    { id: 'version', term: 'Version', definition: versionDefinition },
    // Distinct from "Version": `revision` is the exact executable artifact
    // this run started against (identity/diagnostics/pinning), while
    // `versionTuple` above is the sole semantic-compatibility axis. Two
    // revisions can share one workflowVersion (e.g. a doc-only redeploy).
    // Always shown — see module doc "Revision row (WFT-117)".
    { id: 'revision', term: 'Revision', definition: revisionDefinition },
    { id: 'created', term: 'Created', definition: new Date(workflow.createdAt).toISOString() },
    ...(workflow.executionDeadline !== undefined
      ? [
          {
            id: 'deadline',
            term: 'Deadline',
            definition: new Date(workflow.executionDeadline).toISOString(),
          },
        ]
      : []),
  ]);
</script>

{#snippet typeDefinition()}
  <code class="ib-identifier weft-overview-tab__code">{workflow.type}</code>
{/snippet}

{#snippet versionDefinition()}
  <code class="ib-identifier weft-overview-tab__code">{versionSummaryText}</code>
{/snippet}

{#snippet revisionDefinition()}
  {#if revisionComparison === 'unpinned'}
    Unpinned (pre-revision record)
  {:else}
    <code class="ib-identifier weft-overview-tab__code">{workflow.revision}</code
    >{REVISION_COMPARISON_SUFFIX[revisionComparison]}
  {/if}
{/snippet}

<div class="weft-overview-tab">
  <div class="weft-overview-tab__panel">
    <div class="weft-overview-tab__panel-header">Definition</div>
    <DescriptionList items={definitionItems} variant="default" />
    <div class="weft-overview-tab__tags" title={tagGate.disabled ? tagGate.title : undefined}>
      <div class="weft-overview-tab__tags-label" id={`workflow-detail-tags-label-${workflow.id}`}>
        Tags
      </div>
      <TagInput
        id={`workflow-detail-tags-${workflow.id}`}
        aria-labelledby={`workflow-detail-tags-label-${workflow.id}`}
        placeholder="Add tag"
        disabled={tagGate.disabled}
        bind:value={tags}
        onValueChange={changeTags}
      />
    </div>
  </div>

  <div class="weft-overview-tab__right">
    <div class="weft-overview-tab__panel">
      <div class="weft-overview-tab__panel-header">Input</div>
      <PayloadInspector value={workflow.input} label="Input payload" />
    </div>

    {#if workflow.status === 'completed'}
      <div class="weft-overview-tab__panel">
        <div class="weft-overview-tab__panel-header">Result</div>
        <PayloadInspector value={workflow.result} label="Result payload" />
      </div>
    {:else if workflow.status === 'failed'}
      <div class="weft-overview-tab__failure">
        <div class="weft-overview-tab__failure-title">
          <CircleX aria-hidden="true" size={18} />
          <span>Failed</span>
          {#if workflow.failureCategory !== undefined}
            <Badge variant="danger">{failureCategoryLabel(workflow.failureCategory)}</Badge>
          {/if}
        </div>
        {#if workflow.failureCategory !== undefined}
          <p class="weft-overview-tab__failure-explanation">
            {failureCategoryExplanation(workflow.failureCategory)}
          </p>
        {/if}
        {#if workflow.error}
          <p class="weft-overview-tab__failure-explanation">{workflow.error}</p>
        {/if}
        {#if errorStack.length > 0}
          <Collapsible trigger="Show full stack trace">
            <pre class="weft-send-tab__result">{errorStack}</pre>
          </Collapsible>
        {/if}
      </div>
    {:else if workflow.status === 'cancelled' || workflow.status === 'timed-out'}
      <div class="weft-overview-tab__pending-result">
        This run ended as <strong
          >{workflow.status === 'cancelled' ? 'cancelled' : 'timed out'}</strong
        > — no result value.
      </div>
    {:else}
      <div class="weft-overview-tab__pending-result">
        <span class="weft-overview-tab__spinner" aria-hidden="true"></span>
        Result pending — workflow still {workflow.status}.
      </div>
    {/if}

    {#if attributeAccess !== undefined && attributesClient !== undefined}
      <AttributesPanel
        client={attributesClient}
        workflowId={workflow.id}
        canRead={attributeAccess.canRead}
        canWrite={attributeAccess.canWrite}
      />
    {/if}

    <WorkerBindingPanel {workflow} />

    <LineagePanel {client} {workflow} />
  </div>
</div>

<style>
  /* A revision is a long hash with no break points, so it wraps wherever the card ends. */
  .weft-overview-tab__code {
    overflow-wrap: anywhere;
    word-break: break-all;
  }

  .weft-overview-tab__spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--cinder-border-strong);
    border-top-color: var(--cinder-accent-solid);
    border-radius: 50%;
    display: inline-block;
    animation: weft-overview-spin 0.7s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .weft-overview-tab__spinner {
      animation-duration: 0.001ms;
    }
  }

  @keyframes weft-overview-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
