/**
 * Browser fixtures for RestartState: each phase open, as the page shows it, so the layout tests
 * can measure the failed card's command row and the captures can show every phase without a
 * click.
 */
export default [
  {
    name: 'restarting',
    host: './restart-state-phase.fixture.svelte',
    props: { phase: 'restarting' },
  },
  {
    name: 'reconnecting',
    host: './restart-state-phase.fixture.svelte',
    props: { phase: 'reconnecting' },
  },
  {
    name: 'failed',
    host: './restart-state-phase.fixture.svelte',
    props: { phase: 'failed' },
  },
];
