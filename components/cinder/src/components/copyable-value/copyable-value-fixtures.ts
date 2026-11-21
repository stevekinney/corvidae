/**
 * Visual-regression fixtures for CopyableValue.
 *
 * The default `assertion` fixture renders one address in a narrow place. `addresses` renders the
 * two addresses Settings shows, so the browser tests can narrow each one and read where it breaks.
 */
export default [
  {
    name: 'addresses',
    host: './copyable-value-addresses.fixture.svelte',
  },
];
