<script lang="ts">
  /**
   * Needs attention: the system problems that need a person now, as one list in a card (rows 76g
   * to 76k). They are the Bureau's own list (`bureau.health.attention`), shown in the order it
   * gives, most recent first, with one glyph tile per kind and a secondary button for every
   * action. The count chip is neutral and these are never counted as Needs you. This list is the
   * page's status: there is no banner above it. With nothing to report the card collapses to one
   * row with a green check, and a list that could not be read says so rather than claiming all is
   * well. Line two is the row's meta, so it sits directly under the title with the actions centred
   * beside both lines (rows 76h, 76i, 76u), not the third `detail` line a phone's row adds.
   */
  import {
    Badge,
    Button,
    Card,
    DataList,
    Skeleton,
    StackedListItem,
    type StackedListItemAction,
  } from '@lostgradient/cinder';
  import {
    CalendarClock,
    Check,
    Database,
    Plug,
    Server,
    Sparkles,
    TriangleAlert,
    Webhook,
  } from '@lucide/svelte';
  import type { Component } from 'svelte';

  import { router } from '../../lib/router.svelte.ts';
  import type { AttentionGlyph, AttentionRow } from './attention-rows.ts';
  import { HEALTH_ATTENTION_COPY as copy } from './health-copy.ts';

  interface Props {
    /** The rows, or `undefined` while the list has not answered. */
    rows: readonly AttentionRow[] | undefined;
    /** Whether the list could not be read. */
    failed?: boolean;
    /** Whether the caller may not read the list. */
    forbidden?: boolean;
    onRetry?: (() => void) | undefined;
  }

  let { rows, failed = false, forbidden = false, onRetry = undefined }: Props = $props();

  const GLYPHS: Readonly<Record<AttentionGlyph, Component>> = {
    provider: Sparkles,
    storage: Database,
    schedule: CalendarClock,
    hook: Webhook,
    plugin: Plug,
    worker: Server,
    alert: TriangleAlert,
  };

  /** Opens `path` in place, and leaves a modified click to the browser. */
  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  function actionsOf(row: AttentionRow): StackedListItemAction[] {
    return row.actions.map((action) => ({
      label: action.label,
      href: router.href(action.href),
      onclick: (event: MouseEvent) => open(event, action.href),
    }));
  }
</script>

<Card padding="none" class="ib-needs-attention" data-testid="needs-attention">
  {#snippet header()}
    <div class="ib-needs-attention__heading">
      <h2 class="ib-needs-attention__title">{copy.title}</h2>
      {#if rows !== undefined && rows.length > 0}
        <Badge
          variant="neutral"
          size="sm"
          aria-label={`${rows.length} ${rows.length === 1 ? 'problem' : 'problems'}`}
        >
          {rows.length}
        </Badge>
      {/if}
    </div>
  {/snippet}

  {#if rows === undefined && !failed && !forbidden}
    <Skeleton
      variant="list"
      rows={3}
      statusMarker="dot"
      statusColumn={false}
      framed={false}
      label={`Loading ${copy.title.toLowerCase()}`}
    />
  {:else if forbidden}
    <p class="ib-needs-attention__note">{copy.lockedTitle}</p>
  {:else if failed}
    <div class="ib-needs-attention__note" role="alert">
      <p class="ib-needs-attention__note-title">{copy.unavailableTitle}</p>
      <p class="ib-needs-attention__note-line">{copy.unavailableLine}</p>
      {#if onRetry !== undefined}
        <Button variant="secondary" size="sm" label={copy.retry} onclick={onRetry} />
      {/if}
    </div>
  {:else if rows !== undefined && rows.length === 0}
    <ul class="ib-needs-attention__clear" aria-label={copy.listLabel}>
      <StackedListItem lines leadingTone="success">
        {#snippet leading()}<Check aria-hidden="true" size={16} />{/snippet}
        {#snippet title()}{copy.allClearTitle}{/snippet}
        {#snippet meta()}{copy.allClearLine}{/snippet}
      </StackedListItem>
    </ul>
  {:else if rows !== undefined}
    <DataList items={[...rows]} key={(row) => row.id} aria-label={copy.listLabel}>
      {#snippet children(row)}
        {@const Glyph = GLYPHS[row.glyph]}
        <StackedListItem
          lines
          wrapMeta
          leadingTone="warning"
          actions={actionsOf(row)}
          data-attention={row.id}
        >
          {#snippet leading()}<Glyph aria-hidden="true" size={16} />{/snippet}
          {#snippet title()}{row.title}{/snippet}
          {#snippet meta()}{row.description}{/snippet}
        </StackedListItem>
      {/snippet}
    </DataList>
  {/if}
</Card>

<style>
  .ib-needs-attention__heading {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
  }

  .ib-needs-attention__title {
    margin: 0;
    font-size: var(--cinder-text-md);
    font-weight: 600;
  }

  .ib-needs-attention__clear {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-needs-attention__note {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--cinder-space-2);
    margin: 0;
    color: var(--cinder-text-muted);
  }

  .ib-needs-attention__note-title {
    margin: 0;
    color: var(--cinder-text-default);
    font-weight: 600;
  }

  .ib-needs-attention__note-line {
    margin: 0;
  }
</style>
