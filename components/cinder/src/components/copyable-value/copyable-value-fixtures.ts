/**
 * Visual-regression fixtures for CopyableValue.
 *
 * The default `assertion` fixture renders one address in a narrow place. `addresses` renders the
 * two addresses Settings shows, so the browser tests can narrow each one and read where it breaks,
 * and the API address after the words that introduce it, which must move whole to the next row.
 */
export default [
  {
    name: 'addresses',
    host: './copyable-value-addresses.fixture.svelte',
  },
];
