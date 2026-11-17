<script lang="ts" module>
  /**
   * @cinder
   * @category feedback
   * @status beta
   * @purpose Quiet inline dot-and-word status for a live connection, telling connecting, live, reconnecting, polling, stale, out-of-date, and closed apart by shape and text, not color alone.
   * @tag connection
   * @tag status
   * @tag realtime
   * @useWhen Surfacing the transport-level health of a websocket, SSE stream, or polling loop as a compact, self-contained dot and word.
   * @useWhen Distinguishing push (`live`) from interval polling (`polling`) so operators don't mistake one for the other.
   * @avoidWhen Annotating a static entity's state (a row, a user, a deployment) rather than a live transport — use status-dot instead. | status-dot
   * @avoidWhen Rendering a full event log with per-event connection transitions — use feed's log arm instead. | feed
   * @a11yPattern role="status" live region
   * @a11yNote Status is conveyed by shape and text together, never color alone (WCAG 1.4.1): live is a dot, out-of-date a hollow ring, the rest an icon. The live pulsing dot collapses to a static dot under prefers-reduced-motion.
   * @related status-dot, feed, badge
   */
  export type {
    ConnectionIndicatorProps,
    ConnectionIndicatorSchemaProps,
    ConnectionIndicatorStatus,
  } from './connection-indicator.types.ts';
</script>

<script lang="ts">
  import Loader from '@lucide/svelte/icons/loader';
  import RefreshCcwDot from '@lucide/svelte/icons/refresh-ccw-dot';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import WifiOff from '@lucide/svelte/icons/wifi-off';
  import { classNames } from '../../utilities/class-names.ts';
  import type {
    ConnectionIndicatorProps,
    ConnectionIndicatorStatus,
  } from './connection-indicator.types.ts';

  const statusLabels: Record<ConnectionIndicatorStatus, string> = {
    connecting: 'Connecting',
    live: 'Live',
    reconnecting: 'Reconnecting',
    polling: 'Polling',
    stale: 'Stale',
    'out-of-date': 'Out of date',
    closed: 'Closed',
  };

  // `live` has no icon: the pulsing dot is its whole glyph, and the "Live" label still names the
  // state, so the state is never carried by color alone (WCAG 1.4.1).
  // `reconnecting` is the same with a still, neutral dot: while the server is unreachable the
  // banner carries the retries and the count, so the indicator only says "Reconnecting".
  // `out-of-date` draws its hollow ring as the glyph. None of the three is in this table.
  const statusIcons: Record<
    Exclude<ConnectionIndicatorStatus, 'live' | 'reconnecting' | 'out-of-date'>,
    typeof Loader
  > = {
    connecting: Loader,
    polling: RefreshCcwDot,
    stale: TriangleAlert,
    closed: WifiOff,
  };

  let {
    status,
    label,
    attempt,
    class: className,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledby,
    ...rest
  }: ConnectionIndicatorProps = $props();

  // Normalize empty/whitespace-only ARIA name props to `undefined` so an empty
  // attribute is never emitted (which would suppress the accessible-name
  // fallback). A provided aria-labelledby takes precedence, so the automatic
  // aria-label default steps aside for it.
  const normalizedAriaLabel = $derived(ariaLabel?.trim() ? ariaLabel.trim() : undefined);
  const normalizedAriaLabelledby = $derived(
    ariaLabelledby?.trim() ? ariaLabelledby.trim() : undefined,
  );
  const resolvedLabel = $derived(label?.trim() ? label.trim() : statusLabels[status]);
  const resolvedAriaLabel = $derived(
    normalizedAriaLabelledby !== undefined
      ? undefined
      : (normalizedAriaLabel ?? `Connection: ${resolvedLabel}`),
  );
  const Icon = $derived(
    status === 'live' || status === 'reconnecting' || status === 'out-of-date'
      ? undefined
      : statusIcons[status],
  );
</script>

<div
  {...rest}
  class={classNames('cinder-connection-indicator', className)}
  data-cinder-status={status}
  role="status"
  aria-live="polite"
  aria-atomic="true"
  aria-label={resolvedAriaLabel}
  aria-labelledby={normalizedAriaLabelledby}
>
  {#if status === 'out-of-date'}
    <span class="cinder-connection-indicator__ring" aria-hidden="true"></span>
  {:else if Icon === undefined}
    <span class="cinder-connection-indicator__dot" aria-hidden="true"></span>
  {:else}
    <span class="cinder-connection-indicator__icon" aria-hidden="true">
      <Icon size={13} strokeWidth={2.25} />
    </span>
  {/if}
  <span class="cinder-connection-indicator__label">{resolvedLabel}</span>
  {#if status === 'reconnecting' && attempt}
    <span class="cinder-connection-indicator__attempt">{@render attempt()}</span>
  {/if}
</div>
