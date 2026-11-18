/**
 * Browser fixtures for StackedListItem.
 *
 * The default `assertion` fixture is the application's own. `leading-checkbox` leads rows with a
 * checkbox beside a one-line title and a title that clamps to two lines, so the layout tests can
 * measure where the box sits against the first line of the title, which happy-dom cannot.
 * `narrow-trailing` draws a row whose trailing region is a chevron and one whose trailing region is
 * a button, both under the 448px container width, so the layout tests can measure that only the
 * button drops under the body; under them, a row with a status in a 360px pane, so the layout
 * tests can measure the row's own width driving the phone form.
 */
export default [
  {
    name: 'leading-checkbox',
    host: './stacked-list-item.fixture.svelte',
  },
  {
    name: 'narrow-trailing',
    host: './stacked-list-item-trailing.fixture.svelte',
  },
  // A `wrapMeta` row at 320px whose line two wraps: it reads as one run of text, the dot, the word
  // and the meta, so the wrapped line starts at the row's text edge.
  {
    name: 'wrap-meta',
    host: './stacked-list-item-wrap-meta.fixture.svelte',
  },
];
