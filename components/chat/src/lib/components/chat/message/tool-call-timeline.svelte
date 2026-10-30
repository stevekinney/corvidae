<script lang="ts">
  import type { Snippet } from 'svelte';
  import {
    Brain,
    ChevronRight,
    CircleDot,
    Globe,
    Pencil,
    Search,
    Terminal,
    type ApprovalState,
  } from '@lostgradient/cinder';
  import { stringify } from '../../../utilities/stringify.ts';
  import { toolResultText } from '../../../utilities/tool-result-text.ts';
  import type { ToolCallPair } from '../conversation-model.ts';
  import type { ToolCallPresentation } from '../utilities/types.ts';
  import { formatToolCallProse } from '../utilities/utilities.ts';
  import ToolPayloadCode from './tool-payload-code.svelte';
  import {
    formatToolCallDuration,
    isProblemStatus,
    toolCallKeyArgument,
    toolCallResultLine,
    toolCallRowStatus,
    toolCallStatusText,
    toolCallSummarySegments,
  } from './tool-call-summary.ts';

  let {
    pairs,
    messageId,
    describeToolCall,
    expanded = false,
    onToggle,
    activityActive = true,
    approvalStates,
    durations,
  }: {
    pairs: ToolCallPair[];
    messageId?: string;
    describeToolCall?: ((pair: ToolCallPair) => ToolCallPresentation | undefined) | undefined;
    expanded?: boolean;
    onToggle?: (() => void) | undefined;
    activityActive?: boolean;
    approvalStates?: ReadonlyMap<string, ApprovalState> | undefined;
    durations?: ReadonlyMap<string, number> | undefined;
  } = $props();
  const navigationMessageId = $derived(messageId ?? pairs[0]?.call.id ?? 'tool-call-timeline');
  const headingId = $derived(`message-${navigationMessageId}-tool-call-summary`);
  const listId = $derived(`${navigationMessageId}-tool-calls`);

  const rows = $derived(
    pairs.map((pair, index) => {
      const presentation = describeToolCall?.(pair);
      const status = toolCallRowStatus(pair, approvalStates?.get(pair.call.id));
      const duration = durations?.get(pair.call.id);
      return {
        key: `${index}:${pair.call.id}`,
        detailsId: `${navigationMessageId}-${index}-${pair.call.id}-details`,
        pair,
        presentation,
        status,
        keyArgument: toolCallKeyArgument(pair.call.arguments),
        resultLine: toolCallResultLine(pair),
        duration,
        icon: presentation
          ? toolActivityIcon(
              presentation.kind,
              activityActive && presentation.tense === 'present' && !pair.result,
            )
          : undefined,
      };
    }),
  );
  const hasProblem = $derived(rows.some((row) => isProblemStatus(row.status)));
  const summarySegments = $derived(
    toolCallSummarySegments(
      pairs,
      rows.map((row) => row.status),
      rows.map((row) => row.duration),
    ),
  );

  // Failures and denials start open; the reader's own toggle wins after that.
  let groupOverride = $state<boolean | undefined>(undefined);
  const groupOpen = $derived(groupOverride ?? (expanded || hasProblem));
  let callOverrides = $state(new Map<string, boolean>());

  function toggleGroup(): void {
    groupOverride = !groupOpen;
    onToggle?.();
  }

  function isCallOpen(row: (typeof rows)[number]): boolean {
    return callOverrides.get(row.key) ?? isProblemStatus(row.status);
  }

  function toggleCall(row: (typeof rows)[number]): void {
    callOverrides = new Map(callOverrides).set(row.key, !isCallOpen(row));
  }

  function isStructured(value: unknown): boolean {
    return value === null || typeof value === 'object';
  }

  const callsLabel = $derived(
    `${pairs.length} consecutive tool ${pairs.length === 1 ? 'call' : 'calls'}`,
  );
  const announcerText = $derived(
    rows.map((row) => `${row.pair.call.name}: ${toolCallStatusText(row.status)}`).join('. '),
  );

  function toolActivityIcon(kind: ToolCallPresentation['kind'], active: boolean): Snippet {
    if (kind === 'search') return active ? searchActiveIcon : searchIcon;
    if (kind === 'fetch') return active ? fetchActiveIcon : fetchIcon;
    if (kind === 'write') return active ? writeActiveIcon : writeIcon;
    if (kind === 'execute') return active ? executeActiveIcon : executeIcon;
    if (kind === 'reason') return active ? reasonActiveIcon : reasonIcon;
    return active ? defaultActiveIcon : defaultIcon;
  }
</script>

{#snippet searchIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="search">
    <Search aria-hidden="true" />
  </span>
{/snippet}

{#snippet searchActiveIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="search" data-cinder-tool-activity-active>
    <Search aria-hidden="true" />
  </span>
{/snippet}

{#snippet fetchIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="fetch">
    <Globe aria-hidden="true" />
  </span>
{/snippet}

{#snippet fetchActiveIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="fetch" data-cinder-tool-activity-active>
    <Globe aria-hidden="true" />
  </span>
{/snippet}

{#snippet writeIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="write">
    <Pencil aria-hidden="true" />
  </span>
{/snippet}

{#snippet writeActiveIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="write" data-cinder-tool-activity-active>
    <Pencil aria-hidden="true" />
  </span>
{/snippet}

{#snippet executeIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="execute">
    <Terminal aria-hidden="true" />
  </span>
{/snippet}

{#snippet executeActiveIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="execute" data-cinder-tool-activity-active>
    <Terminal aria-hidden="true" />
  </span>
{/snippet}

{#snippet reasonIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="reason">
    <Brain aria-hidden="true" />
  </span>
{/snippet}

{#snippet reasonActiveIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="reason" data-cinder-tool-activity-active>
    <Brain aria-hidden="true" />
  </span>
{/snippet}

{#snippet defaultIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="generic">
    <CircleDot aria-hidden="true" />
  </span>
{/snippet}

{#snippet defaultActiveIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="generic" data-cinder-tool-activity-active>
    <CircleDot aria-hidden="true" />
  </span>
{/snippet}

{#snippet payload(label: string, value: unknown)}
  <div class="chat-tool-call-payload">
    <span class="chat-tool-call-payload-label">{label}</span>
    {#if isStructured(value)}
      <ToolPayloadCode
        code={value === null ? 'null' : stringify(value)}
        languageLabelVisible={false}
      />
    {:else}
      <p class="chat-tool-call-payload-text">{String(value)}</p>
    {/if}
  </div>
{/snippet}

{#snippet output(pair: ToolCallPair)}
  {#if pair.result?.outcome === 'error'}
    {@render payload('Error', pair.result.error?.message ?? pair.result.content)}
  {:else if pair.result?.parts !== undefined && pair.result}
    {@render payload('Output', toolResultText(pair.result))}
  {:else if pair.result}
    {@render payload('Output', pair.result.content)}
  {/if}
{/snippet}

<section
  id={`message-${navigationMessageId}`}
  class="chat-tool-call-timeline chat-navigation-row"
  data-cinder-tool-call-count={pairs.length}
  aria-labelledby={headingId}
  tabindex="-1"
>
  <span class="cinder-sr-only" aria-live="polite" aria-atomic="true">{announcerText}</span>
  <h3 id={headingId} class="chat-tool-call-heading">
    <button
      type="button"
      class="chat-tool-call-toggle"
      aria-expanded={groupOpen}
      aria-controls={listId}
      onclick={toggleGroup}
    >
      <ChevronRight class="chat-tool-call-chevron" aria-hidden="true" />
      <span>Used {pairs.length === 1 ? '1 tool' : `${pairs.length} tools`}</span>
      {#each summarySegments as segment, index (index)}
        <span aria-hidden="true">{' · '}</span>
        <span class="chat-tool-call-summary-segment">{segment}</span>
      {/each}
    </button>
  </h3>
  <ol id={listId} class="chat-tool-call-list" aria-label={callsLabel} hidden={!groupOpen}>
    {#each rows as row (row.key)}
      {@const open = isCallOpen(row)}
      <li class="chat-tool-call-item" data-cinder-tool-call-status={row.status}>
        <button
          type="button"
          class="chat-tool-call-row"
          aria-expanded={open}
          aria-controls={row.detailsId}
          onclick={() => toggleCall(row)}
        >
          {#if row.icon}{@render row.icon()}{/if}
          {#if row.presentation}
            <span class="chat-tool-call-label">{formatToolCallProse(row.presentation)}</span>
          {:else}
            <code class="chat-tool-call-name">{row.pair.call.name}</code>
            {#if row.keyArgument}<span>{row.keyArgument}</span>{/if}
          {/if}
          <span class="chat-tool-call-result">
            {#if row.resultLine}→ {row.resultLine}{/if}
          </span>
          {#if row.status !== 'succeeded'}
            <span class="chat-tool-call-status">{toolCallStatusText(row.status)}</span>
          {/if}
          {#if row.duration !== undefined}
            <span class="chat-tool-call-duration">{formatToolCallDuration(row.duration)}</span>
          {/if}
        </button>
        <div id={row.detailsId} class="chat-tool-call-details" hidden={!open}>
          {#if open}
            {@render payload('Input', row.pair.call.arguments)}
            {@render output(row.pair)}
          {/if}
        </div>
      </li>
    {/each}
  </ol>
</section>

<style>
  /* Quiet by design: no border or fill, muted 12.5px text, a small chevron. */
  .chat-tool-call-timeline {
    inline-size: min(42rem, 100%);
    min-inline-size: 0;
    max-inline-size: 100%;
    font-size: 12.5px;
    color: var(--cinder-text-muted);
  }

  @container (min-width: 22rem) {
    .chat-tool-call-timeline {
      min-inline-size: 20rem;
    }
  }

  .chat-tool-call-timeline:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  @media (forced-colors: active) {
    .chat-tool-call-timeline:focus-visible {
      outline: var(--cinder-ring-width) solid ButtonText;
    }
  }

  .chat-tool-call-heading {
    margin: 0;
    font: inherit;
  }

  .chat-tool-call-toggle,
  .chat-tool-call-row {
    display: flex;
    align-items: center;
    gap: 6px;
    inline-size: 100%;
    min-inline-size: 0;
    padding: 2px 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }

  .chat-tool-call-toggle {
    inline-size: auto;
  }

  .chat-tool-call-toggle:focus-visible,
  .chat-tool-call-row:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  .chat-tool-call-toggle :global(.chat-tool-call-chevron) {
    inline-size: 12px;
    block-size: 12px;
    flex: none;
    transition: transform 120ms ease;
  }

  .chat-tool-call-toggle[aria-expanded='true'] :global(.chat-tool-call-chevron) {
    transform: rotate(90deg);
  }

  .chat-tool-call-summary-segment {
    font-variant-numeric: tabular-nums;
  }

  .chat-tool-call-list {
    display: flex;
    flex-direction: column;
    margin: 4px 0 2px 5px;
    padding: 0 0 0 12px;
    border-inline-start: 1px solid var(--cinder-border-muted);
    list-style: none;
  }

  .chat-tool-call-list[hidden],
  .chat-tool-call-details[hidden] {
    display: none;
  }

  .chat-tool-call-row {
    gap: 8px;
  }

  .chat-tool-call-name {
    font-family: var(--cinder-font-mono);
    font-size: 12px;
    color: var(--cinder-text-default);
  }

  .chat-tool-call-result {
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-tool-call-status,
  .chat-tool-call-duration {
    flex: none;
    font-variant-numeric: tabular-nums;
  }

  .chat-tool-call-item[data-cinder-tool-call-status='failed'] .chat-tool-call-status {
    color: var(--cinder-status-danger-text);
  }

  .chat-tool-call-details {
    --cinder-code-block-padding: var(--cinder-space-3);
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 4px 0 6px;
  }

  .chat-tool-call-payload {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .chat-tool-call-payload-label {
    font-size: 11.5px;
    color: var(--cinder-text-subtle);
  }

  .chat-tool-call-payload-text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--cinder-text-default);
  }

  .chat-tool-call-activity-icon {
    display: inline-flex;
    flex: none;
  }

  .chat-tool-call-activity-icon :global(svg) {
    inline-size: 12px;
    block-size: 12px;
  }

  .chat-tool-call-activity-icon[data-cinder-tool-activity-active] {
    animation: chat-tool-call-pulse 1.4s ease-in-out infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-tool-call-toggle :global(.chat-tool-call-chevron) {
      transition: none;
    }

    .chat-tool-call-activity-icon[data-cinder-tool-activity-active] {
      animation: none;
    }
  }

  @keyframes chat-tool-call-pulse {
    0%,
    100% {
      opacity: 0.6;
    }

    50% {
      opacity: 1;
    }
  }
</style>
