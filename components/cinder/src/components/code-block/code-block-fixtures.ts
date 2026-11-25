/**
 * Visual-regression fixtures for CodeBlock.
 *
 * The default `assertion` fixture renders a plain block. `bar` renders the block between two
 * paragraphs with a language and Copy, each alone, neither, a long language label, line numbers,
 * a line that scrolls and the same line wrapped, so the browser tests can measure the bar and the
 * block's one surface. `rail` renders a floating Copy named by a 40-character label, a scrolling
 * block and a wrapping one, so the browser tests can measure the copy rail and the block's width.
 * `breaks` renders the command and the JSON that Settings › MCP shows, each with endpoints of
 * three widths, in a wrapping block, so the browser tests can read where each row ends.
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
  {
    name: 'breaks',
    host: './code-block-breaks.fixture.svelte',
  },
];
