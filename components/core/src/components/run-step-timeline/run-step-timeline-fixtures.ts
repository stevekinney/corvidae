/**
 * Browser fixtures for RunStepTimeline.
 *
 * `connectors` sets every marker state, a wrapped title and nested steps in both variants, so the
 * layout tests can measure each connector against the two markers it joins, which happy-dom
 * cannot.
 */
export default [
  {
    name: 'connectors',
    host: './run-step-timeline-connectors.fixture.svelte',
  },
];
