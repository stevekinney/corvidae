<script lang="ts" module>
  /**
   * @cinder
   * @category feedback
   * @status stable
   * @purpose Decorative placeholder that reserves layout space while real content loads, as a single block or a group of lines or a card, with optional delayed appearance and a "Still loading" status.
   * @tag feedback
   * @tag loading
   * @useWhen Reserving the rough shape of incoming content during an initial fetch to avoid layout shift.
   * @useWhen Indicating progressive load of cards, rows, or media tiles where the final shape is known.
   * @avoidWhen Indicating indeterminate background work without a known target shape — use spinner.
   * @avoidWhen Communicating that a view has no data at all — use empty-state.
   * @related spinner, empty-state, progress
   */
  export type { SkeletonProps, SkeletonStatusMarker, SkeletonVariant } from './skeleton.types.ts';
</script>

<script lang="ts">
  import { getContext, setContext, untrack, type Snippet } from 'svelte';

  import type { SkeletonProps } from './skeleton.types.ts';
  import Button from '../button/button.svelte';
  import VisuallyHidden from '../visually-hidden/visually-hidden.svelte';
  import { classNames } from '../../utilities/class-names.ts';

  let {
    width,
    height,
    radius,
    class: className,
    lines = 1,
    variant = 'row',
    rows = 3,
    action = false,
    statusMarker = 'bar',
    statusColumn = true,
    framed = true,
    dayBand = false,
    label,
    delay = 0,
    stillLoadingAfter,
    onCancel,
    stillLoadingLabel = 'Still loading. This is taking longer than usual.',
    cancelLabel = 'Cancel',
    holdsStatusLine = false,
    children,
  }: SkeletonProps = $props();

  /**
   * What a group with a "Still loading" line tells the placeholders inside its `children`: one of
   * them (`holdsStatusLine`) can take the line in its own place, so the line appears where that
   * placeholder was and nothing around it moves.
   */
  interface StatusPlace {
    readonly active: boolean;
    readonly stillLoading: boolean;
    readonly line: Snippet;
    claim(): () => void;
  }

  const STATUS_PLACE = 'cinder-skeleton-status-place';
  // Read before this skeleton provides its own, so a placeholder sees its group's.
  const statusHolder = untrack(() => holdsStatusLine)
    ? getContext<StatusPlace | undefined>(STATUS_PLACE)
    : undefined;
  /** How many placeholders inside have taken the line; while one has, the group draws none. */
  let statusClaims = $state(0);

  const MAXIMUM_LINES = 20;

  // The timers only ever turn these flags on. A prop change after they fire does not hide
  // the placeholder again: a skeleton that has appeared stays until its owner unmounts it.
  let delayElapsed = $state(false);
  let stillLoadingElapsed = $state(false);

  // A zero (or invalid) delay renders on the first pass, so server rendering and a skeleton
  // without timing props behave exactly as a plain block always has.
  const visible = $derived(!(delay > 0) || delayElapsed);
  // A non-numeric or non-finite threshold means "never", the same as omitting it.
  const stillLoadingThreshold = $derived(
    typeof stillLoadingAfter === 'number' && Number.isFinite(stillLoadingAfter)
      ? Math.max(0, stillLoadingAfter)
      : undefined,
  );
  const stillLoading = $derived(
    stillLoadingThreshold !== undefined && (stillLoadingThreshold === 0 || stillLoadingElapsed),
  );

  $effect(() => {
    const handles: ReturnType<typeof setTimeout>[] = [];
    if (delay > 0) {
      handles.push(
        setTimeout(() => {
          delayElapsed = true;
        }, delay),
      );
    }
    if (stillLoadingThreshold !== undefined && stillLoadingThreshold > 0) {
      handles.push(
        setTimeout(() => {
          stillLoadingElapsed = true;
        }, stillLoadingThreshold),
      );
    }
    return () => {
      for (const handle of handles) clearTimeout(handle);
    };
  });

  // Coerce + clamp at runtime: a consumer can pass 0, NaN, or a fraction despite `number`.
  const lineCount = $derived.by(() => {
    const whole = Math.trunc(Number(lines));
    return Number.isFinite(whole) ? Math.min(MAXIMUM_LINES, Math.max(1, whole)) : 1;
  });
  const SHAPES = new Set(['card', 'list', 'grouped', 'form']);
  const shape = $derived(SHAPES.has(variant) ? variant : 'row');
  const rowCount = $derived.by(() => {
    const whole = Math.trunc(Number(rows));
    return Number.isFinite(whole) ? Math.min(MAXIMUM_LINES, Math.max(1, whole)) : 3;
  });
  /** How many fields a form placeholder draws: `rows`, which defaults to 3 for a list, is 2 here unless it was set. */
  const formRows = $derived(rowCount);
  const grouped = $derived(
    lineCount > 1 ||
      shape !== 'row' ||
      stillLoadingThreshold !== undefined ||
      children !== undefined,
  );

  const style = $derived(
    [
      width !== undefined ? `width: ${width}` : null,
      height !== undefined ? `height: ${height}` : null,
      radius !== undefined ? `border-radius: ${radius}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join('; '),
  );

  setContext<StatusPlace>(STATUS_PLACE, {
    get active() {
      return stillLoadingThreshold !== undefined;
    },
    get stillLoading() {
      return stillLoading;
    },
    line: statusLine,
    // Untracked: the placeholder claims from its own effect, which must not come to depend on
    // the count it changes.
    claim() {
      untrack(() => (statusClaims += 1));
      return () => {
        untrack(() => (statusClaims -= 1));
      };
    },
  });

  // A placeholder that holds its group's line tells the group, which then draws none of its own.
  $effect(() => (statusHolder?.active ? statusHolder.claim() : undefined));
</script>

<!-- The group's line, drawn by the placeholder that holds it: the same live region as the group's
     own, in the placeholder's place. -->
{#snippet statusLine()}
  <div class="cinder-skeleton-status" role="status">
    {#if stillLoading}
      <span class="cinder-skeleton-status-label">{stillLoadingLabel}</span>
      {#if onCancel}
        <Button variant="ghost" size="sm" label={cancelLabel} onclick={() => onCancel()} />
      {/if}
    {/if}
  </div>
{/snippet}

{#snippet stillLoadingStatus()}
  {#if stillLoadingThreshold !== undefined && statusClaims === 0}
    <div class="cinder-skeleton-status" role="status">
      {#if stillLoading}
        <span class="cinder-skeleton-status-label">{stillLoadingLabel}</span>
        {#if onCancel}
          <Button variant="ghost" size="sm" label={cancelLabel} onclick={() => onCancel()} />
        {/if}
      {/if}
    </div>
  {/if}
{/snippet}

{#if shape === 'list' || shape === 'grouped'}
  <!-- The region is in the DOM from the first pass so its name is announced when the rows
       appear at the end of `delay`, not inserted together with its text. -->
  <div
    class={classNames('cinder-skeleton-group', className)}
    data-cinder-variant={shape}
    aria-busy={visible ? 'true' : undefined}
  >
    {#if label}
      <VisuallyHidden role="status">{visible ? label : ''}</VisuallyHidden>
    {/if}
    <!-- The status line leads the group: after a long wait it is read first, above the
         placeholders, never below a page of them out of view (COR-2329). -->
    {#if visible}
      {@render stillLoadingStatus()}
    {/if}
    {#if visible && shape === 'grouped'}
      <!-- A grouped list's rows: one rounded surface, separators inset at the text. -->
      <div class="cinder-skeleton-grouped" aria-hidden="true">
        {#each { length: rowCount } as _, index (index)}
          <div
            class={classNames(
              'cinder-skeleton-grouped-row',
              action && 'cinder-skeleton-grouped-row--action',
            )}
          >
            <div class="cinder-skeleton-grouped-content">
              <!-- Each bar sits in a line box of the text it stands for, so the row is as tall. -->
              <div class="cinder-skeleton-grouped-text">
                <div class="cinder-skeleton-grouped-line cinder-skeleton-grouped-line--title">
                  <div class="cinder-skeleton cinder-skeleton-title-bar"></div>
                </div>
                <div class="cinder-skeleton-grouped-line cinder-skeleton-grouped-line--subtitle">
                  <div class="cinder-skeleton cinder-skeleton-meta-bar"></div>
                </div>
              </div>
              {#if action}
                <div class="cinder-skeleton cinder-skeleton-action-bar"></div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {:else if visible}
      <div
        class="cinder-skeleton-list"
        data-cinder-framed={framed ? undefined : 'false'}
        aria-hidden="true"
      >
        {#if dayBand}
          <div class="cinder-skeleton-day-band">
            <div class="cinder-skeleton cinder-skeleton-day-bar"></div>
          </div>
        {/if}
        {#each { length: rowCount } as _, index (index)}
          <div
            class="cinder-skeleton-row"
            data-cinder-status-column={statusColumn ? undefined : 'none'}
          >
            <div class="cinder-skeleton-row-status">
              <div
                class="cinder-skeleton cinder-skeleton-status-bar"
                data-cinder-marker={statusMarker === 'dot' ? 'dot' : undefined}
              ></div>
            </div>
            <div class="cinder-skeleton-row-text">
              <div class="cinder-skeleton cinder-skeleton-title-bar"></div>
              <div class="cinder-skeleton cinder-skeleton-meta-bar"></div>
            </div>
            <div class="cinder-skeleton-row-time">
              <div class="cinder-skeleton cinder-skeleton-time-bar"></div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{:else if visible}
  {#if grouped}
    <div
      class={classNames('cinder-skeleton-group', className)}
      data-cinder-variant={children ? 'custom' : shape}
      aria-busy={children ? 'true' : undefined}
    >
      {#if label}
        <VisuallyHidden role="status">{label}</VisuallyHidden>
      {/if}
      {@render stillLoadingStatus()}
      {#if children}
        {@render children()}
      {:else}
        <div class="cinder-skeleton-lines" aria-hidden="true">
          {#if shape === 'card'}
            <div class="cinder-skeleton cinder-skeleton-heading"></div>
          {/if}
          {#if shape === 'form'}
            {#each { length: formRows } as _, index (index)}
              <div class="cinder-skeleton cinder-skeleton-field-label"></div>
              <div class="cinder-skeleton cinder-skeleton-field-control"></div>
            {/each}
          {/if}
          {#each { length: shape === 'form' ? 0 : lineCount } as _, index (index)}
            <div
              class="cinder-skeleton"
              data-cinder-last={index === lineCount - 1 && lineCount > 1 && width === undefined
                ? ''
                : undefined}
              {style}
            ></div>
          {/each}
        </div>
      {/if}
    </div>
  {:else if statusHolder?.active}
    <!-- The group's "Still loading" line takes this placeholder's place: a box this tall holds the
         bar, then the line in its stead, so nothing around it moves when the line appears. -->
    <div
      class="cinder-skeleton-status-place"
      style={height === undefined ? undefined : `block-size: ${height}`}
    >
      {@render statusHolder.line()}
      <div class={classNames('cinder-skeleton', className)} aria-hidden="true" {style}></div>
    </div>
  {:else}
    <div class={classNames('cinder-skeleton', className)} aria-hidden="true" {style}></div>
  {/if}
{/if}
