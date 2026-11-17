/**
 * Visual-regression fixtures for Toggle.
 *
 * The default `assertion` fixture renders the off state. `on` adds the on
 * state, whose accent track and travelled thumb the off fixture never shows, and
 * `alignment` sets one-line and three-line labels beside the switch so the layout
 * tests can measure the first-line alignment that happy-dom cannot.
 */
export default [
  {
    name: 'on',
    host: './toggle.fixture.svelte',
    props: {
      checked: true,
    },
  },
  {
    name: 'alignment',
    host: './toggle-alignment.fixture.svelte',
  },
];
