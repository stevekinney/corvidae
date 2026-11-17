/**
 * Visual-regression fixtures for Table.
 */
export default [
  {
    name: 'contributors',
    host: './table.fixture.svelte',
  },
  {
    name: 'selected-row',
    host: './table.fixture.svelte',
    interact: [{ action: 'click', target: { label: 'Select Grace Hopper' } }],
  },
  {
    name: 'sorted-name',
    host: './table.fixture.svelte',
    // A stacked table hides its header (sorting stays on the visually hidden header buttons), so
    // the sort button has nothing to click below the stack width. Keep the table layout at every
    // width here; the `contributors` fixture covers the stacked layout.
    props: { stackBelow: false },
    interact: [{ action: 'click', target: { role: 'button', name: 'Name' } }],
  },
];
