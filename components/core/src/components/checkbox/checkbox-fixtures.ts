/**
 * Browser fixtures for Checkbox.
 *
 * The default `assertion` fixture is the application's own. This one lays out single-line and
 * three-line labels beside the box, the task variant, a described field and a bare box, so the
 * layout tests can measure the hit area and the first-line alignment that happy-dom cannot.
 */
export default [
  {
    name: 'alignment',
    host: './checkbox.fixture.svelte',
  },
];
