<script lang="ts">
  /**
   * One quarantined memory of an agent, in the detail pane of the Quarantined memories view: a
   * heading, why it was quarantined and when (the checks' own words, or that its owner did it),
   * the held text, set apart as flagged text so content a check held is never the loudest thing on
   * screen, and the view's one action, "Release from quarantine", a plain primary button under the
   * rows. Forget is on its context line, as for any memory. A quarantined memory is not served by
   * `bureau.memory.get`, so the page hands over what the Quarantined list read, `quarantine`
   * included; when the address names a memory that list does not hold, `missing` says which of two
   * true things it is: more pages are unread, or the memory is not quarantined.
   *
   * Releasing is the page's (`memory-governance.svelte`), which asks the server to scan the memory
   * again. While it runs the button shows progress through Cinder's loading contract and keeps its
   * place in the focus order (`releasing`), and a refusal is said here, above the button, with its
   * own title and what is true now and what to do (`fault`); the details stay open, because the
   * memory is still quarantined. The held text is drawn as text, never as markup.
   */
  import { Alert, Button, Callout, DescriptionList, Skeleton } from '@lostgradient/cinder';
  import { Trash2 } from '@lucide/svelte';

  import { MEMORY_COPY } from '../../app/copy/memory.ts';
  import type { Memory, MemoryFault } from '../../lib/memory-client.ts';
  import {
    contextLine,
    memoryTimes,
    quarantineWhy,
    refusalWords,
    writerName,
  } from './memory-presentation.ts';

  type Props = {
    id: string;
    /** What the agent is called, for the memories it wrote. */
    agentName: string;
    /** The memory the Quarantined list read, or `undefined` while that list is still being read. */
    memory: Memory | undefined;
    /** Why there is no `memory` once the list was read: pages are unread, or it is not quarantined. */
    missing?: 'unread' | 'absent' | undefined;
    /** True while a different change on the page is being saved, which holds this one. */
    governancePending: boolean;
    /** True while this memory is being released. */
    releasing: boolean;
    /** What refused the last release of this memory. */
    fault: MemoryFault | undefined;
    onRelease: (memory: Memory) => void;
    onForget: (memory: Memory) => void;
  };

  let {
    id,
    agentName,
    memory,
    missing,
    governancePending,
    releasing,
    fault,
    onRelease,
    onForget,
  }: Props = $props();

  const words = MEMORY_COPY.govern.release;
</script>

<article class="ib-memory-detail" data-memory-detail={id} data-memory-quarantined>
  {#if memory === undefined && missing !== undefined}
    <Alert variant="warning">
      <p class="ib-memory-detail__alert-title">{MEMORY_COPY.detail.notFound.title}</p>
      <p class="ib-memory-detail__alert-body" data-quarantined-missing={missing}>
        {MEMORY_COPY.quarantinedView.notHere[missing]}
      </p>
    </Alert>
  {:else if memory === undefined}
    <div role="status" aria-busy="true" aria-label={MEMORY_COPY.detail.loading}>
      <Skeleton height="1.5rem" width="60%" />
      <Skeleton height="6rem" />
    </div>
  {:else}
    {@const rows = [
      ...(memory.quarantine === undefined
        ? []
        : [
            {
              id: 'quarantined',
              term: words.detail.quarantinedRow,
              definition: memoryTimes(memory.quarantine.at, Date.now()).row,
            },
          ]),
      { id: 'why', term: words.detail.whyRow, definition: quarantineWhy(memory.quarantine) },
      {
        id: 'written-by',
        term: MEMORY_COPY.detail.fields.writtenBy,
        definition: writerName(memory, agentName, 'detail'),
      },
    ]}
    <div class="ib-memory-detail__context">
      <h2 class="ib-memory-detail__heading" data-quarantined-heading>{words.detail.heading}</h2>
      <span class="ib-memory-detail__tools">
        <Button
          data-changes
          variant="ghost"
          size="sm"
          iconOnly
          title={MEMORY_COPY.forget.iconLabel}
          aria-label={MEMORY_COPY.forget.iconLabel}
          onclick={() => onForget(memory)}
        >
          <Trash2 aria-hidden="true" size={16} />
        </Button>
      </span>
    </div>
    <p class="ib-memory-detail__kind" data-memory-context>{contextLine(memory, Date.now())}</p>

    <Callout variant="neutral" semantic="note" title={words.detail.flaggedText}>
      <p class="ib-memory-detail__flagged" data-memory-text>{memory.content}</p>
    </Callout>

    <DescriptionList variant="two-column" items={rows} />

    {#if fault !== undefined}
      {@const refused =
        fault.kind === 'forbidden' ? MEMORY_COPY.govern.refusal.forbidden : refusalWords(fault)}
      <Alert variant="danger">
        <p
          class="ib-memory-detail__alert-title"
          data-release-refusal={fault.kind === 'not-released' ? fault.reason : fault.kind}
        >
          {refused.title}
        </p>
        {#if refused.description !== ''}
          <p class="ib-memory-detail__alert-body">{refused.description}</p>
        {/if}
      </Alert>
    {/if}

    <div class="ib-memory-detail__actions">
      <!-- Not disabled while it runs: Cinder's loading state keeps the button in the focus order. -->
      <Button
        data-changes
        data-release
        variant="primary"
        loading={releasing}
        disabled={governancePending && !releasing}
        onclick={() => onRelease(memory)}>{words.action}</Button
      >
    </div>
  {/if}
</article>

<style>
  .ib-memory-detail {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }

  .ib-memory-detail__context {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2) var(--cinder-space-3);
  }

  .ib-memory-detail__heading {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: 600;
  }

  .ib-memory-detail__kind {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-memory-detail__tools {
    display: inline-flex;
    gap: var(--cinder-space-1);
    margin-inline-start: auto;
  }

  /* The held text keeps its line breaks and wraps anywhere, so a long one never scrolls sideways. */
  .ib-memory-detail__flagged {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }

  .ib-memory-detail__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

  .ib-memory-detail__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-memory-detail__alert-body {
    margin: var(--cinder-space-1) 0;
  }
</style>
