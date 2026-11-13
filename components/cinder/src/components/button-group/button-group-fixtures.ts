/**
 * Visual-regression fixtures for ButtonGroup.
 *
 * The default `assertion` fixture renders three secondary buttons in a row. `joins` renders every
 * join a group draws: horizontal and vertical groups of two to four members in three variants,
 * members wrapped in a Tooltip, right to left, and split buttons with a Dropdown, so the browser
 * tests can read each member's corner radii and edges.
 */
export default [
  {
    name: 'joins',
    host: './button-group-joins.fixture.svelte',
  },
];
