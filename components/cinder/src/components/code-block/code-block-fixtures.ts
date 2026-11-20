/**
 * Visual-regression fixtures for CodeBlock.
 *
 * The default `assertion` fixture renders a plain block. `bar` renders the block between two
 * paragraphs with a language and Copy, each alone, neither, a long language label, line numbers,
 * a line that scrolls and the same line wrapped, so the browser tests can measure the bar and the
 * block's one surface. `rail` renders a floating Copy named by a 40-character label, a scrolling
 * block and a wrapping one, so the browser tests can measure the copy rail and the block's width.
 */
export default [
  {
    name: 'bar',
    host: './code-block-bar.fixture.svelte',
  },
  {
    name: 'rail',
    host: './code-block-rail.fixture.svelte',
  },
];
