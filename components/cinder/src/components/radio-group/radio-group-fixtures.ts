/**
 * Browser fixtures for RadioGroup.
 *
 * The default `assertion` fixture is the application's own. This one sets a single-line option, a
 * three-line option and a described three-line option, so the layout tests can measure where the
 * circle sits against the first line of the label, which happy-dom cannot.
 */
export default [
  {
    name: 'alignment',
    host: './radio-group.fixture.svelte',
  },
];
