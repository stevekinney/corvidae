/**
 * Visual-regression fixtures for Banner.
 *
 * The default `assertion` fixture renders an info banner. `alignment` renders the Unreachable and
 * Offline presets and a success banner, each with its glyph, so the layout tests can measure the
 * glyph against the first line of the message, which happy-dom cannot.
 */
export default [
  {
    name: 'alignment',
    host: './banner-alignment.fixture.svelte',
  },
];
