<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status beta
   * @purpose One turn's tool calls on a rail: a one-line row per call, the first and last few with the middle folded, failures and calls that need a person always in view, and the run's end state.
   * @tag timeline
   * @tag tool-call
   * @tag agent
   * @useWhen Showing an agent's tool calls for one chat turn, where a failure or an approval must never fold away.
   * @useWhen Opening a call's details in a side panel from a selectable row, with a failed call's next steps on the rail.
   * @avoidWhen Showing the steps of a run with their own timing, retries and branches — use run-step-timeline.
   * @avoidWhen Listing dated events — use timeline.
   * @rationale Nearest alternative: Timeline — a tool call has no timestamp to lead with, so the rail draws Timeline's marker column and connector around rows of name, key input, result and duration.
   * @related timeline, run-step-timeline, approval-card, status-dot
   */
  export type {
    ToolCallRailCall,
    ToolCallRailLabels,
    ToolCallRailProps,
    ToolCallRailStatus,
  } from './tool-call-rail.types.ts';
</script>

<script lang="ts">
  import Ban from '@lucide/svelte/icons/ban';
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import X from '@lucide/svelte/icons/x';

  import { SvelteMap } from 'svelte/reactivity';
  import type { Attachment } from 'svelte/attachments';

  import { classNames } from '../../utilities/class-names.ts';
  import { planFold, summarizeFoldedNames } from '../../utilities/fold-middle.ts';
  import Spinner from '../spinner/spinner.svelte';
  import Tooltip from '../tooltip/tooltip.svelte';
  import type { ToolCallRailCall, ToolCallRailProps } from './tool-call-rail.types.ts';

  let {
    calls,
    running = false,
    duration,
    open = $bindable(true),
    selectedId,
    onSelect,
    onRetry,
    onCopyInput,
    endLabel,
    footnote,
    label = 'Tool calls',
    labels,
    class: className,
    children,
    ...rest
  }: ToolCallRailProps = $props();

  const listId = $props.id();
  let rootElement = $state<HTMLElement>();
  /** The first call of each folded group the person has opened. */
  let openedGroups = $state<ReadonlySet<string>>(new Set());

  const words = $derived({
    used:
      labels?.used ??
      ((count: number, live: boolean) => `Used ${count} tools${live ? ' so far…' : ''}`),
    failed: labels?.failed ?? ((count: number) => `${count} failed`),
    waiting: labels?.waiting ?? ((count: number) => `${count} waiting on you`),
    showMore: labels?.showMore ?? ((count: number) => `Show ${count} more`),
    folded: labels?.folded ?? ((count: number, names: string) => `${count} done: ${names}`),
    foldedShort: labels?.foldedShort ?? ((count: number) => `${count} done`),
    showFewer: labels?.showFewer ?? 'Show fewer',
    running: labels?.running ?? 'Running…',
    waitingResult: labels?.waitingResult ?? 'Waiting on you',
    denied: labels?.denied ?? 'Denied',
    details: labels?.details ?? 'Details',
    retry: labels?.retry ?? 'Ask the agent to retry',
    copyInput: labels?.copyInput ?? 'Copy input',
  });

  /** One or two calls are plain rows: no summary, no rail and no fold. */
  const plain = $derived(calls.length < 3);
  const failedCount = $derived(calls.filter((call) => call.status === 'failed').length);
  const waitingCount = $derived(calls.filter((call) => call.status === 'waiting').length);

  /** A call that stays on the rail wherever it falls, folded or not. */
  const isPinned = (call: ToolCallRailCall): boolean =>
    call.status === 'failed' ||
    call.status === 'waiting' ||
    call.status === 'denied' ||
    call.status === 'running';

  const plan = $derived.by(() => {
    if (plain) return calls.map((call, index) => ({ kind: 'item' as const, item: call, index }));
    if (!open) {
      return calls.flatMap((call, index) =>
        isPinned(call) ? [{ kind: 'item' as const, item: call, index }] : [],
      );
    }
    // While the turn runs there is no tail: the calls under way are the end of the rail.
    return planFold(calls, { first: 3, last: running ? 0 : 3, isPinned });
  });
  const anyGroupOpen = $derived(
    plan.some((entry) => entry.kind === 'group' && openedGroups.has(entry.items[0]?.id ?? '')),
  );

  // The row elements, so each row's tooltip can anchor to its row and show on hover and on focus.
  const rowElements = new SvelteMap<string, HTMLElement>();
  const trackRow =
    (id: string): Attachment<HTMLElement> =>
    (node) => {
      rowElements.set(id, node);
      return () => {
        if (rowElements.get(id) === node) rowElements.delete(id);
      };
    };

  const resultText = (call: ToolCallRailCall): string => {
    if (call.status === 'running') return call.result ?? words.running;
    if (call.status === 'waiting') return call.result ?? words.waitingResult;
    if (call.status === 'denied') return call.result ?? words.denied;
    if (call.result === undefined || call.result === '') return '';
    // An approved call says what was decided ("Approved by you 10:33 AM · $18.50 refunded"), not
    // what the call returned, so it carries no arrow.
    return call.status === 'approved' ? call.result : `→ ${call.result}`;
  };
  const statusWord = (call: ToolCallRailCall): string =>
    call.status === 'failed' ? 'Failed' : call.status === 'approved' ? 'Approved' : '';

  function toggleGroup(id: string): void {
    const next = new Set(openedGroups);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    openedGroups = next;
  }

  /** Moves focus to a call's row, for a panel that closes and hands focus back to where it came from. */
  export function focusCall(id: string): void {
    for (const button of rootElement?.querySelectorAll<HTMLElement>(
      '[data-cinder-tool-call-row]',
    ) ?? []) {
      if (button.dataset['cinderToolCallRow'] === id) {
        button.focus();
        return;
      }
    }
  }
</script>

{#snippet marker(call: ToolCallRailCall)}
  <span class="cinder-tool-call-rail__marker" data-cinder-status={call.status} aria-hidden="true">
    {#if call.status === 'running'}
      <Spinner size="sm" variant="arc" />
    {:else if call.status === 'waiting'}
      <ShieldAlert class="cinder-tool-call-rail__glyph" />
    {:else if call.status === 'denied'}
      <Ban class="cinder-tool-call-rail__glyph" />
    {:else if call.status === 'failed'}
      <X class="cinder-tool-call-rail__glyph" />
    {:else}
      <span class="cinder-tool-call-rail__dot"></span>
    {/if}
  </span>
{/snippet}

{#snippet cells(call: ToolCallRailCall)}
  {@render marker(call)}
  <span class="cinder-tool-call-rail__name">
    {#if statusWord(call) !== ''}<span class="cinder-sr-only">{statusWord(call)}:</span
      >{' '}{/if}{call.name}
  </span>
  <span class="cinder-tool-call-rail__detail">
    {#if call.input !== undefined && call.input !== ''}
      <span class="cinder-tool-call-rail__input" title={call.input}>{call.input}</span>
    {/if}
    {#if resultText(call) !== ''}
      <span class="cinder-tool-call-rail__result" title={resultText(call)}>{resultText(call)}</span>
    {/if}
  </span>
  <span class="cinder-tool-call-rail__duration">{call.duration ?? ''}</span>
{/snippet}

{#snippet row(call: ToolCallRailCall)}
  {@const selected = selectedId === call.id}
  <li
    class="cinder-tool-call-rail__item"
    data-cinder-status={call.status}
    data-cinder-selected={selected ? '' : undefined}
  >
    {#if onSelect}
      <button
        type="button"
        class="cinder-tool-call-rail__row"
        data-cinder-tool-call-row={call.id}
        aria-pressed={selected}
        onclick={() => onSelect(call.id)}
        {@attach trackRow(call.id)}
      >
        {@render cells(call)}
      </button>
    {:else}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -- a row that cannot be chosen still takes focus, so a keyboard or touch user can reach the tool's identifier in its tooltip. -->
      <div
        class="cinder-tool-call-rail__row"
        data-cinder-tool-call-row={call.id}
        tabindex="0"
        {@attach trackRow(call.id)}
      >
        {@render cells(call)}
      </div>
    {/if}
    <!-- The name never wraps, so the tooltip carries the tool's identifier, or its whole name when it has none. -->
    <Tooltip
      text={call.identifier ?? call.name}
      placement="top"
      triggerRef={rowElements.get(call.id) ?? null}
    />
    {#if call.status === 'failed' && call.failure !== undefined && call.failure !== ''}
      <div class="cinder-tool-call-rail__failure">
        <span class="cinder-tool-call-rail__failure-text">
          <CircleX class="cinder-tool-call-rail__failure-glyph" aria-hidden="true" />
          <span>{call.failure}</span>
        </span>
        <span class="cinder-tool-call-rail__links">
          {#if onSelect}
            <button
              type="button"
              class="cinder-tool-call-rail__link"
              onclick={() => onSelect(call.id)}
            >
              {words.details}
            </button>
          {/if}
          {#if onRetry}
            <button
              type="button"
              class="cinder-tool-call-rail__link"
              onclick={() => onRetry(call.id)}
            >
              {words.retry}
            </button>
          {/if}
          {#if onCopyInput}
            <button
              type="button"
              class="cinder-tool-call-rail__link"
              onclick={() => onCopyInput(call.id)}
            >
              {words.copyInput}
            </button>
          {/if}
        </span>
      </div>
    {/if}
    {#if call.nested && children}
      <div class="cinder-tool-call-rail__nested">{@render children(call)}</div>
    {/if}
  </li>
{/snippet}

<section
  {...rest}
  bind:this={rootElement}
  class={classNames('cinder-tool-call-rail', className)}
  aria-label={label}
  data-cinder-plain={plain ? '' : undefined}
  data-cinder-running={running ? '' : undefined}
>
  {#if !plain}
    {#if running}
      <p class="cinder-tool-call-rail__summary" data-cinder-running="">
        <span class="cinder-tool-call-rail__summary-marker" aria-hidden="true">
          <Spinner size="sm" variant="arc" />
        </span>
        <span class="cinder-tool-call-rail__summary-text">{words.used(calls.length, true)}</span>
      </p>
    {:else}
      <button
        type="button"
        class="cinder-tool-call-rail__summary"
        aria-expanded={open}
        aria-controls={listId}
        onclick={() => (open = !open)}
      >
        <span class="cinder-tool-call-rail__summary-marker" aria-hidden="true">
          {#if open}
            <ChevronDown class="cinder-tool-call-rail__chevron" />
          {:else}
            <ChevronRight class="cinder-tool-call-rail__chevron" />
          {/if}
        </span>
        <span class="cinder-tool-call-rail__summary-text">{words.used(calls.length, false)}</span>
        {#if failedCount > 0}
          <span class="cinder-tool-call-rail__summary-separator" aria-hidden="true">·</span>
          <span class="cinder-tool-call-rail__count" data-cinder-count="failed">
            <span class="cinder-tool-call-rail__count-dot" aria-hidden="true"></span>
            {words.failed(failedCount)}
          </span>
        {/if}
        {#if waitingCount > 0}
          <span class="cinder-tool-call-rail__summary-separator" aria-hidden="true">·</span>
          <span class="cinder-tool-call-rail__count" data-cinder-count="waiting">
            <span class="cinder-tool-call-rail__count-dot" aria-hidden="true"></span>
            {words.waiting(waitingCount)}
          </span>
        {/if}
        {#if duration !== undefined && duration !== ''}
          <span
            class="cinder-tool-call-rail__summary-separator"
            data-cinder-duration=""
            aria-hidden="true">·</span
          >
          <span class="cinder-tool-call-rail__summary-duration">{duration}</span>
        {/if}
      </button>
    {/if}
  {/if}
  {#if plan.length > 0}
    <ol id={listId} class="cinder-tool-call-rail__list">
      {#each plan as entry (entry.kind === 'group' ? `group-${entry.items[0]?.id}` : entry.item.id)}
        {#if entry.kind === 'item'}
          {@render row(entry.item)}
        {:else if openedGroups.has(entry.items[0]?.id ?? '')}
          {#each entry.items as call (call.id)}
            {@render row(call)}
          {/each}
        {:else}
          <li class="cinder-tool-call-rail__group">
            <span class="cinder-tool-call-rail__marker" aria-hidden="true">
              <span class="cinder-tool-call-rail__dot" data-cinder-faint=""></span>
            </span>
            <span class="cinder-tool-call-rail__group-body">
              <button
                type="button"
                class="cinder-tool-call-rail__more"
                aria-expanded="false"
                onclick={() => toggleGroup(entry.items[0]?.id ?? '')}
              >
                <ChevronRight class="cinder-tool-call-rail__more-chevron" aria-hidden="true" />
                {words.showMore(entry.items.length)}
              </button>
              <span class="cinder-tool-call-rail__group-summary">
                <span class="cinder-tool-call-rail__group-summary-long">
                  {words.folded(
                    entry.items.length,
                    summarizeFoldedNames(entry.items.map((call) => call.name)),
                  )}
                </span>
                <span class="cinder-tool-call-rail__group-summary-short">
                  {words.foldedShort(entry.items.length)}
                </span>
              </span>
            </span>
          </li>
        {/if}
      {/each}
    </ol>
  {/if}
  {#if anyGroupOpen}
    <div class="cinder-tool-call-rail__fewer">
      <button
        type="button"
        class="cinder-tool-call-rail__link"
        onclick={() => (openedGroups = new Set())}
      >
        {words.showFewer}
      </button>
    </div>
  {/if}
  {#if endLabel !== undefined && endLabel !== ''}
    <p class="cinder-tool-call-rail__end">
      <span class="cinder-tool-call-rail__marker" aria-hidden="true">
        <Check class="cinder-tool-call-rail__end-glyph" />
      </span>
      {endLabel}
    </p>
  {/if}
  {#if footnote !== undefined && footnote !== ''}
    <p class="cinder-tool-call-rail__footnote">{footnote}</p>
  {/if}
</section>
