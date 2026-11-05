<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status stable
   * @purpose Single event inside a timeline rail with a decorative tone marker, timestamp-first header, optional group header, and body content.
   * @tag timeline
   * @tag event
   * @useWhen Rendering one event along a timeline rail with consistent marker, header, connector, and body structure.
   * @useWhen Coloring decorative markers by tone (info, success, warning, error, or a hollow pending ring) while keeping the meaningful status in title or content.
   * @avoidWhen The entry lives in a social activity stream rather than a workflow rail — feed-event fits better.
   * @related timeline, feed-event
   */
  export type { TimelineItemProps } from './timeline-item.types.ts';
</script>

<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';

  import { classNames } from '../../utilities/class-names.ts';
  import StackedListItem from '../stacked-list-item/stacked-list-item.svelte';
  import StatusDot from '../status-dot/status-dot.svelte';
  import type { StatusDotStatus } from '../status-dot/status-dot.types.ts';
  import type { TimelineHeadingLevel, TimelineTone } from '../timeline/timeline.types.ts';
  import type { TimelineItemProps } from './timeline-item.types.ts';

  let {
    datetime,
    timestamp,
    title,
    tone = 'info',
    kind = 'event',
    detail,
    expanded = $bindable(false),
    onexpandedchange,
    status,
    href,
    duration,
    struck = false,
    plain = false,
    bare = false,
    expandLabel = 'Show',
    collapseLabel = 'Hide',
    connectorAfter = 'visible',
    groupHeader,
    groupHeaderLevel = 3,
    class: className,
    children,
    marker,
    actions,
    ...rest
  }: TimelineItemProps = $props();

  // Render a native h1–h6 rather than `<div role="heading">`. Native headings
  // carry stronger, more widely supported semantics (outline navigation, implicit
  // level) and match the codebase pattern in section-heading and form-section.
  // Coerce + clamp at runtime: JS/schema-driven callers can pass 0/7/NaN, which
  // would emit invalid <h0>/<hNaN>. Matches card.svelte and empty-state.svelte.
  const resolvedGroupHeaderLevel = $derived(
    Number.isFinite(Math.trunc(Number(groupHeaderLevel)))
      ? Math.min(6, Math.max(1, Math.trunc(Number(groupHeaderLevel))))
      : 3,
  );
  // A band's dot follows the entry's tone, and is named for it so colour is never the only signal.
  const bandDots: Record<TimelineTone, { status: StatusDotStatus; label: string }> = {
    info: { status: 'info', label: 'Information' },
    success: { status: 'success', label: 'Done' },
    warning: { status: 'warning', label: 'Needs attention' },
    error: { status: 'danger', label: 'Failed' },
    pending: { status: 'pending', label: 'Pending' },
  };
  const bandDot = $derived(bandDots[tone]);
  const groupHeaderTag = $derived(`h${resolvedGroupHeaderLevel}` as `h${TimelineHeadingLevel}`);
</script>

{#snippet bandStatus()}
  <StatusDot status={bandDot.status} label={bandDot.label} labelVisible={false} />
{/snippet}
{#snippet bandTitle()}{title}{/snippet}
{#snippet bandDetail()}{detail}{/snippet}
{#snippet bandDetails()}
  {#if children}{@render children()}{/if}
{/snippet}
{#snippet runStatus()}
  {#if status}<StatusDot word={status} size="sm" />{/if}
{/snippet}
{#snippet runTitle()}
  <time {datetime}>{timestamp}</time>
{/snippet}
{#snippet runDetail()}{detail}{/snippet}
{#snippet runTrailing()}
  {#if duration}<span class="cinder-timeline-item__duration">{duration}</span>{/if}
  {#if href}<ChevronRight size={16} aria-hidden="true" />{/if}
{/snippet}

<li
  {...rest}
  class={classNames('cinder-timeline-item', className)}
  data-cinder-tone={tone}
  data-cinder-kind={kind}
  data-cinder-connector-after={connectorAfter}
  data-cinder-bare={bare ? '' : undefined}
  data-cinder-plain={plain ? '' : undefined}
>
  {#if groupHeader}
    <svelte:element this={groupHeaderTag} class="cinder-timeline__group-header">
      {groupHeader}
    </svelte:element>
  {/if}
  {#if kind === 'now'}
    <!-- The current moment: a pill, a rule and the time. The rule is decoration. -->
    <div class="cinder-timeline-item__now">
      <span class="cinder-timeline-item__now-label">{title}</span>
      <span class="cinder-timeline-item__rule" aria-hidden="true"></span>
      <time class="cinder-timeline-item__time" {datetime}>{timestamp}</time>
    </div>
  {:else if kind === 'band'}
    <!-- One collapsed group row below Now: the stacked-list-item band draws it, so it is not drawn twice. -->
    <ul class="cinder-timeline-item__band">
      <StackedListItem
        groupLayout="band"
        tone={tone === 'warning' ? 'warning' : 'neutral'}
        {expandLabel}
        {collapseLabel}
        bind:expanded={
          () => expanded,
          (open) => {
            expanded = open;
            onexpandedchange?.(open);
          }
        }
        tooltip={title}
        {...detail === undefined ? {} : { metaTooltip: detail, meta: bandDetail }}
        status={bandStatus}
        title={bandTitle}
        details={bandDetails}
      />
    </ul>
  {:else if kind === 'run'}
    <!-- A past run: Cinder's status-first row, linked as a whole, with its duration and a chevron. -->
    <ul class="cinder-timeline-item__run">
      <StackedListItem
        {...href === undefined ? {} : { href }}
        {...detail === undefined ? {} : { metaTooltip: detail, meta: runDetail }}
        tooltip={timestamp}
        status={runStatus}
        title={runTitle}
        trailing={runTrailing}
      />
    </ul>
  {:else if kind === 'separator'}
    <!-- A quiet labelled break. The rules are decoration; the label is the content. -->
    <div class="cinder-timeline-item__separator">
      <span class="cinder-timeline-item__rule" aria-hidden="true"></span>
      <span class="cinder-timeline-item__separator-label">{title}</span>
      <span class="cinder-timeline-item__rule" aria-hidden="true"></span>
    </div>
  {:else}
    <div class="cinder-timeline-item__event" data-cinder-has-actions={actions ? '' : undefined}>
      <span class="cinder-timeline-item__marker" aria-hidden="true" inert>
        {#if marker}
          {@render marker()}
        {/if}
      </span>
      <div class="cinder-timeline-item__content">
        {#if bare}
          {#if children}{@render children()}{/if}
        {:else}
          <header class="cinder-timeline-item__header">
            <time
              class="cinder-timeline-item__time"
              {datetime}
              data-cinder-struck={struck ? '' : undefined}>{timestamp}</time
            >
            <span class="cinder-timeline-item__title">{title}</span>
          </header>
          {#if children}
            <div class="cinder-timeline-item__body">{@render children()}</div>
          {/if}
        {/if}
      </div>
      {#if actions}
        <div class="cinder-timeline-item__actions">{@render actions()}</div>
      {/if}
    </div>
  {/if}
</li>
