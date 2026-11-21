/**
 * Visual-regression fixtures for Skeleton.
 *
 * `still-loading` draws the bars, card and form placeholders with their slow-load line and Cancel,
 * each beside the same placeholder before the line appears, and a list that leads with a day band,
 * so the layout test can measure that the line holds its place and that Cancel is never cut short
 * on a phone (COR-2489).
 */
export default [
  {
    name: 'still-loading',
    host: './skeleton-still-loading.fixture.svelte',
  },
];
