/**
 * Visual-regression fixtures for BarChart.
 *
 * The default `assertion` fixture renders grouped and horizontal bars. `stacked` renders vertical
 * and horizontal stacks, with a zero top segment and values below zero, beside the same data
 * grouped, so the browser tests can read which end of each bar is rounded.
 */
export default [
  {
    name: 'stacked',
    host: './bar-chart-stacked.fixture.svelte',
  },
];
