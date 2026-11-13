/**
 * Visual-regression fixtures for MatrixChart.
 *
 * The default `assertion` fixture renders a confusion matrix. `ramp` renders eleven steps along
 * the sequential and the diverging ramp, with a cell that has no value, so the browser tests can
 * check every number's contrast against its own cell in both themes.
 */
export default [
  {
    name: 'ramp',
    host: './matrix-chart-ramp.fixture.svelte',
  },
];
