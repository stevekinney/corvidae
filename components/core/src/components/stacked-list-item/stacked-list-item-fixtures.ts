/**
 * Browser fixtures for StackedListItem.
 *
 * The default `assertion` fixture is the application's own. `leading-checkbox` leads rows with a
 * checkbox beside a one-line title and a title that clamps to two lines, so the layout tests can
 * measure where the box sits against the first line of the title, which happy-dom cannot.
 */
export default [
  {
    name: 'leading-checkbox',
    host: './stacked-list-item.fixture.svelte',
  },
];
