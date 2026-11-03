<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status beta
   * @purpose Live-updating relative or absolute time label in the viewer's zone, with the other reading in a tooltip.
   * @tag relative-time
   * @useWhen Showing when a message, issue, or event happened.
   * @avoidWhen An exact calendar date is required.
   * @related date-picker
   * @rationale Nearest alternative: time element — RelativeTime owns the shared date format ("4 min ago", "Yesterday, 4:12 PM"), the viewer's zone and ticking.
   */
  export type { RelativeTimeProps } from './relative-time.types.ts';

  type ClockSubscriber = {
    notify: (now: number) => void;
    getDelay: (now: number) => number;
    nextAt: number;
  };
  const clockSubscribers = new Set<ClockSubscriber>();
  let clockTimer: number | undefined;

  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  // Beyond an hour the label only changes at a day boundary, which a short poll catches promptly.
  const SLOW_POLL = 5 * MINUTE;

  /** Milliseconds until the label can next read differently: the next whole minute, then a slow poll. */
  function nextDisplayedValueDelay(timestamp: number, now: number): number {
    if (!Number.isFinite(timestamp)) return 86_400_000;
    const distance = Math.abs(now - timestamp);
    if (distance >= HOUR) return SLOW_POLL;
    const remainder = distance % MINUTE;
    const untilBoundary =
      timestamp <= now ? MINUTE - remainder : remainder === 0 ? MINUTE : remainder;
    return Math.max(1, untilBoundary + 1);
  }

  function scheduleClock() {
    if (clockTimer !== undefined) window.clearTimeout(clockTimer);
    if (clockSubscribers.size === 0) {
      clockTimer = undefined;
      return;
    }
    const now = Date.now();
    const nextAt = Math.min(...[...clockSubscribers].map((subscriber) => subscriber.nextAt));
    clockTimer = window.setTimeout(
      () => {
        clockTimer = undefined;
        const nextNow = Date.now();
        for (const subscriber of clockSubscribers) {
          if (subscriber.nextAt <= nextNow) {
            subscriber.notify(nextNow);
            subscriber.nextAt = nextNow + subscriber.getDelay(nextNow);
          }
        }
        scheduleClock();
      },
      Math.max(1, nextAt - now),
    );
  }

  function subscribeToClock(subscriber: ClockSubscriber): () => void {
    subscriber.nextAt = Date.now() + subscriber.getDelay(Date.now());
    clockSubscribers.add(subscriber);
    scheduleClock();
    return () => {
      clockSubscribers.delete(subscriber);
      scheduleClock();
    };
  }
</script>

<script lang="ts">
  import { getLocaleContext } from '../../_internal/locale-context.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { formatDate, formatDateTime, formatRelativeTime } from '../../utilities/format-date.ts';

  import type { RelativeTimeProps } from './relative-time.types.ts';

  const initialNow = Date.now();
  let {
    date = initialNow,
    locale,
    timeZone,
    format = 'relative',
    dayWords,
    tick = true,
    class: customClassName,
    children,
    ...rest
  }: RelativeTimeProps = $props();
  const localeContext = getLocaleContext();
  let now = $state(initialNow);
  let hasMounted = $state(false);
  $effect(() => {
    hasMounted = true;
  });
  const resolvedLocale = $derived(
    locale ?? localeContext?.locale ?? (hasMounted ? navigator.language : 'en-US'),
  );
  const timestamp = $derived(date instanceof Date ? date.getTime() : new Date(date).getTime());
  const validTimestamp = $derived(Number.isFinite(timestamp));
  const label = $derived.by(() => {
    if (!validTimestamp) return 'Invalid date';
    const options = { locale: resolvedLocale, timeZone, now };
    return format === 'absolute'
      ? formatDateTime(timestamp, { ...options, dayWords: dayWords ?? 'today' })
      : formatRelativeTime(timestamp, {
          ...options,
          ...(dayWords === undefined ? {} : { dayWords }),
        });
  });
  // The other reading of the same moment, so the tooltip adds what the visible label leaves out.
  const tooltip = $derived.by(() => {
    if (!validTimestamp) return undefined;
    if (format === 'absolute')
      return formatRelativeTime(timestamp, { locale: resolvedLocale, timeZone, now });
    return formatDate(timestamp, resolvedLocale, {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    });
  });
  $effect(() => {
    if (!tick || typeof window === 'undefined') return;
    const currentTimestamp = timestamp;
    return subscribeToClock({
      notify: (nextNow) => (now = nextNow),
      getDelay: (nextNow) => nextDisplayedValueDelay(currentTimestamp, nextNow),
      nextAt: 0,
    });
  });
</script>

<time
  class={classNames('cinder-relative-time', customClassName)}
  datetime={validTimestamp ? new Date(timestamp).toISOString() : undefined}
  title={hasMounted ? tooltip : undefined}
  {...rest}
  >{hasMounted ? label : ''}{#if children}{@render children()}{/if}</time
>
