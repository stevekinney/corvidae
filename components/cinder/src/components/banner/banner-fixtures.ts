/**
 * Visual-regression fixtures for Banner.
 *
 * The default `assertion` fixture renders an info banner. `alignment` renders the Unreachable and
 * Offline presets and a success banner, each with its glyph, so the layout tests can measure the
 * glyph against the first line of the message, which happy-dom cannot. `actions` renders banners
 * with actions at full width, in a 24rem column and with `stackActions`, so the layout tests can
 * measure where the actions sit.
 */
export default [
  {
    name: 'alignment',
    host: './banner-alignment.fixture.svelte',
  },
  {
    name: 'actions',
    host: './banner-actions.fixture.svelte',
  },
];
