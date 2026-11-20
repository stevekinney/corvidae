/**
 * Visual-regression fixtures for Tooltip.
 *
 * The default `assertion` fixture renders one tooltip on a button. `closed-panel` renders a tooltip
 * inside a box with a transform, so the browser tests can read whether a closed panel widens it.
 */
export default [
  {
    name: 'closed-panel',
    host: './tooltip-closed-panel.fixture.svelte',
  },
];
