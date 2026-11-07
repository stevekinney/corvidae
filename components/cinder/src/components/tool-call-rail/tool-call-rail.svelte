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
   * @rationale Nearest alternative: Timeline — the rail is built on its `rows` variant, which keeps the marker column and connector and leaves each row's content (name, key input, result and duration, with no timestamp to lead with) to the rail.
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
  import Timeline from '../timeline/timeline.svelte';
  import type { TimelineEntry } from '../timeline/timeline.types.ts';
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
    interrupted: labels?.interrupted ?? 'Interrupted',
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
    call.pinned === true ||
    call.status === 'failed' ||
    call.status === 'waiting' ||
    call.status === 'denied' ||
    call.status === 'interrupted' ||
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

  /** What one Timeline entry draws: a call, or the dashed button that folds a run of them. */
  type RailRow =
    | { kind: 'call'; id: string; call: ToolCallRailCall }
    | { kind: 'group'; id: string; items: readonly ToolCallRailCall[] };

  // Every row of the rail in order, as Timeline entries: an opened group is its calls in time order,
  // a folded one is a single row.
  const rows = $derived.by((): RailRow[] =>
    plan.flatMap((entry): RailRow[] => {
      if (entry.kind === 'item') return [{ kind: 'call', id: entry.item.id, call: entry.item }];
      if (openedGroups.has(entry.items[0]?.id ?? '')) {
        return entry.items.map((call): RailRow => ({ kind: 'call', id: call.id, call }));
      }
      return [{ kind: 'group', id: `group-${entry.items[0]?.id}`, items: entry.items }];
    }),
  );
  // What one entry draws is looked up as a list of none or one, which an each block reads in step
  // with the rows, where a lookup held in a snippet's own constant could be read after the rows moved.
  const callsFor = (id: string): ToolCallRailCall[] =>
    rows.flatMap((row) => (row.kind === 'call' && row.id === id ? [row.call] : []));
  const groupsFor = (id: string): (readonly ToolCallRailCall[])[] =>
    rows.flatMap((row) => (row.kind === 'group' && row.id === id ? [row.items] : []));
  // A rail has nothing dated to say, so the entries carry only their identity and a name.
  const entries = $derived(
    rows.map((row): TimelineEntry => ({
      id: row.id,
      datetime: '',
      timestamp: '',
      title: row.kind === 'call' ? row.call.name : words.foldedShort(row.items.length),
    })),
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
    if (call.status === 'denied') return call.decision ?? call.result ?? words.denied;
    // An interrupted call has no answer to arrow to: its result is the words for how it ended.
    if (call.status === 'interrupted') return call.result ?? words.interrupted;
    // A decision is the person's words ("Approved by you 10:33 AM · $18.50 refunded"), not what
    // the call returned, so it carries no arrow.
    if (call.status === 'approved' && call.decision !== undefined && call.decision !== '') {
      return call.decision;
    }
    return call.result === undefined || call.result === '' ? '' : `→ ${call.result}`;
  };
  /** Whether the row's result is a link: the call has an address and its row shows what came back. */
  const linksResult = (call: ToolCallRailCall): boolean =>
    call.resultHref !== undefined && call.resultHref !== '' && resultText(call).startsWith('→ ');
  /** The accessible name of the button that covers a row whose result is a link. */
  const rowName = (call: ToolCallRailCall): string =>
    [statusWord(call), call.name, call.input, resultText(call), call.duration]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' ');
  const statusWord = (call: ToolCallRailCall): string =>
    call.status === 'failed'
      ? 'Failed'
      : call.status === 'approved'
        ? 'Approved'
        : call.status === 'interrupted'
          ? 'Interrupted'
          : '';

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
    {:else if call.status === 'interrupted'}
      <CircleX class="cinder-tool-call-rail__glyph" />
    {:else}
      <span class="cinder-tool-call-rail__dot"></span>
    {/if}
  </span>
{/snippet}

<!-- A result a link points at: the arrow and the words are one link. It sits above the button that
     covers a selectable row, so it is its own click target (`data-cinder-linked`). -->
{#snippet resultCell(call: ToolCallRailCall)}
  {@const text = resultText(call)}
  {#if linksResult(call)}
    <a class="cinder-tool-call-rail__result-link" href={call.resultHref}>{text}</a>
  {:else}
    {text}
  {/if}
{/snippet}

{#snippet cells(call: ToolCallRailCall)}
  <span class="cinder-tool-call-rail__name">
    {#if statusWord(call) !== ''}<span class="cinder-sr-only">{statusWord(call)}:</span
      >{' '}{/if}{call.name}
  </span>
  <span class="cinder-tool-call-rail__detail">
    {#if call.input !== undefined && call.input !== ''}
      <span class="cinder-tool-call-rail__input" title={call.input}>{call.input}</span>
    {/if}
    {#if resultText(call) !== ''}
      <span class="cinder-tool-call-rail__result" title={resultText(call)}
        >{@render resultCell(call)}</span
      >
    {/if}
  </span>
  <span class="cinder-tool-call-rail__duration">{call.duration ?? ''}</span>
{/snippet}

{#snippet callRow(call: ToolCallRailCall)}
  {@const selected = selectedId === call.id}
  <div
    class="cinder-tool-call-rail__item"
    data-cinder-status={call.status}
    data-cinder-selected={selected ? '' : undefined}
  >
    {#if onSelect && linksResult(call)}
      <!-- A link cannot sit inside a button: the row is a container, and the button covers it with
           the link above it. -->
      <div class="cinder-tool-call-rail__row" data-cinder-linked="" {@attach trackRow(call.id)}>
        {@render cells(call)}
        <button
          type="button"
          class="cinder-tool-call-rail__hit"
          data-cinder-tool-call-row={call.id}
          aria-label={rowName(call)}
          aria-pressed={selected}
          onclick={() => onSelect(call.id)}
        ></button>
      </div>
    {:else if onSelect}
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
  </div>
{/snippet}

{#snippet foldedGroup(items: readonly ToolCallRailCall[])}
  <div class="cinder-tool-call-rail__group">
    <span class="cinder-tool-call-rail__group-body">
      <button
        type="button"
        class="cinder-tool-call-rail__more"
        aria-expanded="false"
        onclick={() => toggleGroup(items[0]?.id ?? '')}
      >
        <ChevronRight class="cinder-tool-call-rail__more-chevron" aria-hidden="true" />
        {words.showMore(items.length)}
      </button>
      <span class="cinder-tool-call-rail__group-summary">
        <span class="cinder-tool-call-rail__group-summary-long">
          {words.folded(items.length, summarizeFoldedNames(items.map((call) => call.name)))}
        </span>
        <span class="cinder-tool-call-rail__group-summary-short">
          {words.foldedShort(items.length)}
        </span>
      </span>
    </span>
  </div>
{/snippet}

<!-- Timeline draws the marker column and the connector; the rail draws what sits in each row. -->
{#snippet railMarker(entry: TimelineEntry)}
  {#each callsFor(entry.id) as call (call.id)}
    {@render marker(call)}
  {/each}
  {#if groupsFor(entry.id).length > 0}
    <span class="cinder-tool-call-rail__marker" aria-hidden="true">
      <span class="cinder-tool-call-rail__dot" data-cinder-faint=""></span>
    </span>
  {/if}
{/snippet}

{#snippet railRow(entry: TimelineEntry)}
  {#each callsFor(entry.id) as call (call.id)}
    {@render callRow(call)}
  {/each}
  {#each groupsFor(entry.id) as items (entry.id)}
    {@render foldedGroup(items)}
  {/each}
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
  {#if rows.length > 0}
    <Timeline
      id={listId}
      class="cinder-tool-call-rail__list"
      variant="rows"
      {entries}
      marker={railMarker}
      children={railRow}
    />
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
