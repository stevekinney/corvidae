/**
 * Visual-regression fixtures for CodeBlock.
 *
 * The default `assertion` fixture renders a plain block. `bar` renders the block between two
 * paragraphs with a language and Copy, each alone, neither, a long language label, line numbers,
 * a line that scrolls and the same line wrapped, so the browser tests can measure the bar and the
 * block's one surface.
 */
export default [
  {
    name: 'bar',
    host: './code-block-bar.fixture.svelte',
  },
];
