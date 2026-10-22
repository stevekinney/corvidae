/**
 * Visual-regression fixtures for Toggle.
 *
 * The default `assertion` fixture renders the off state. This one adds the on
 * state, whose accent track and travelled thumb the off fixture never shows.
 */
export default [
  {
    name: 'on',
    host: './toggle.fixture.svelte',
    props: {
      checked: true,
    },
  },
];
