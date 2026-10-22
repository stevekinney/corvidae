/**
 * Visual-regression fixtures for ScheduleBuilder.
 *
 * Both fixtures leave `value` unset, so the builder opens on its default
 * authoring mode. The second one then selects the Interval tab, which is the
 * only way to capture that mode without seeding an interval value.
 */
export default [
  {
    name: 'presets',
    host: './schedule-builder.fixture.svelte',
  },
  {
    name: 'interval-tab',
    host: './schedule-builder.fixture.svelte',
    interact: [{ action: 'click', target: { role: 'tab', name: 'Interval' } }],
  },
];
