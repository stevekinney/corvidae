/**
 * Visual-regression fixtures for EmptyState.
 *
 * `row-action` draws an EmptyState row with its action beside an ErrorState row with its retry,
 * at the full width and in a column narrower than 26rem, so the layout test can measure that the
 * two place their action at the same inline start when they wrap (COR-2489).
 */
export default [
  {
    name: 'row-action',
    host: './empty-state-row-action.fixture.svelte',
  },
];
