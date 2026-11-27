<script lang="ts">
  /**
   * The run's tags, edited in place (Cinder's `TagInput`). Each change the editor reports is one
   * write per tag, and the writes go through one queue, in the order they were made, each starting
   * once the one before it has settled: an add and a remove of the same tag sent independently can
   * land in either order, and a late add then durably restores a tag the person removed. The run is
   * read again once the queue is empty, whatever the engine answered, so a write that failed puts the
   * field back to what the engine holds; reading between two queued writes would show its half-way
   * state.
   *
   * `requested` is the list the engine was last asked for, so a change is the difference from it and
   * not from the tags the engine last answered with: two quick edits before the engine answers each
   * send their own write, and a tag added and removed in between is not lost.
   */
  import { TagInput } from '@lostgradient/cinder';
  import type { HttpClient } from '@lostgradient/weft';
  import type { WorkflowReadState as WorkflowState } from '../../../lib/client.ts';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { RUN_PAGE_COPY } from '../../../app/copy/runs.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { createSerialQueue } from '../../../lib/serial-queue.ts';
  import type { ScopeGate } from '../../../lib/scopes.svelte.ts';
  import { editableRunTags } from './run-tags.ts';

  interface RunTagsProps {
    readonly client: Pick<HttpClient, 'addTags' | 'removeTags'>;
    readonly workflow: Pick<WorkflowState, 'id' | 'tags'>;
    /** Whether the principal holds `tags:write`; open when omitted. */
    readonly tagGate?: ScopeGate | undefined;
    readonly onClose?: (() => void) | undefined;
  }

  let {
    client,
    workflow,
    tagGate = { disabled: false, title: undefined },
    onClose = undefined,
  }: RunTagsProps = $props();

  // The system's own tags are counted in the rail, never edited by hand.
  const editableTags = editableRunTags;

  const queryClient = useQueryClient();

  function invalidateDetail(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.detail(workflow.id) });
  }

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

  let tags = $state<string[]>(untrack(() => editableTags(workflow.tags)));
  let requested: readonly string[] = untrack(() => editableTags(workflow.tags));
  $effect(() => {
    tags = editableTags(workflow.tags);
    requested = editableTags(workflow.tags);
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
</script>

<div class="ib-run-tags" title={tagGate.disabled ? tagGate.title : undefined}>
  <div class="ib-run-tags__label" id={`workflow-detail-tags-label-${workflow.id}`}>
    {RUN_PAGE_COPY.facts.tags}
  </div>
  {#if tags.length === 0}
    <p class="ib-run__note" data-run-tags-none>{RUN_PAGE_COPY.noTags}</p>
  {/if}
  <TagInput
    {...{ 'data-changes': true }}
    id={`workflow-detail-tags-${workflow.id}`}
    aria-labelledby={`workflow-detail-tags-label-${workflow.id}`}
    placeholder={RUN_PAGE_COPY.addTag}
    disabled={tagGate.disabled}
    onkeydown={(event) => {
      if (event.key === 'Escape') onClose?.();
    }}
    bind:value={tags}
    onValueChange={changeTags}
  />
</div>
