/**
 * Visual-regression fixtures for ScheduleBuilder.
 *
 * The fixture starts from weekdays at 9:00 AM in New York, a fixed zone, so the read-back is the
 * same on every machine that renders it.
 */
export default [
  {
    name: 'weekdays',
    host: './schedule-builder.fixture.svelte',
  },
];
