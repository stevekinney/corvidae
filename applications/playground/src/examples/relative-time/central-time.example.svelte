<script lang="ts" module>
  export const title = 'Central time on one 12-hour clock';
  export const description =
    'The date utilities behind RelativeTime read in the viewer’s zone on one 12-hour clock. This example pins the zone to Central time and "now" to Mon Nov 2, 10:46 AM so the readings are the same every time.';
</script>

<script lang="ts">
  import {
    formatDateTime,
    formatDayAndTime,
    formatDayHeading,
    formatRelativeTime,
    formatScheduleTime,
    formatTimeZoneLabel,
  } from '@lostgradient/cinder';

  const now = Date.parse('2026-11-02T16:46:00Z');
  const clock = { timeZone: 'America/Chicago', now } as const;
  const at = (iso: string) => Date.parse(iso);

  const rows: readonly (readonly [string, string])[] = [
    ['Relative, minutes', formatRelativeTime(now - 4 * 60_000, clock)],
    ['Relative, hours', formatRelativeTime(now - 3_600_000, clock)],
    ['Relative, yesterday', formatRelativeTime(at('2026-11-01T22:12:00Z'), clock)],
    ['Absolute, today', formatDateTime(at('2026-11-02T16:44:00Z'), clock)],
    ['Absolute, earlier', formatDateTime(at('2026-11-01T22:12:00Z') - 86_400_000, clock)],
    [
      'Absolute, a named day',
      formatDateTime(at('2026-11-03T09:00:00Z'), { ...clock, dayWords: false }),
    ],
    ['Day and time', formatDayAndTime(at('2026-11-02T15:20:00Z'), clock)],
    [
      'Spelled, upcoming',
      formatRelativeTime(at('2026-11-04T09:00:00Z'), { ...clock, units: 'spelled' }),
    ],
    ['Zone, short', formatTimeZoneLabel(now, { timeZone: 'America/Chicago' })],
    ['Zone, long', formatTimeZoneLabel(now, { timeZone: 'America/Chicago', style: 'long' })],
    [
      'Schedule time',
      `Every day at ${formatScheduleTime(at('2026-11-03T09:00:00Z'), 'UTC', { timeZone: 'America/Chicago' })}`,
    ],
    ['Day heading, today', formatDayHeading(now, clock)],
    ['Day heading, yesterday', formatDayHeading(at('2026-11-01T22:12:00Z'), clock)],
    ['Day heading, earlier', formatDayHeading(at('2026-10-29T17:00:00Z'), clock)],
  ];
</script>

<dl
  style="display: grid; grid-template-columns: max-content 1fr; gap: var(--cinder-space-1) var(--cinder-space-6); margin: 0; font-size: var(--cinder-text-sm);"
>
  {#each rows as [name, reading] (name)}
    <dt style="color: var(--cinder-text-muted);">{name}</dt>
    <dd style="margin: 0;">{reading}</dd>
  {/each}
</dl>
