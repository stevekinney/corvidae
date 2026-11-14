/**
 * Visual-regression fixtures for JsonEditor.
 *
 * `problem-line` marks the line where the source stops parsing, with its message under it.
 * `long-document` shows thirty-odd lines at once, so a gutter that drifts from its text lines
 * shows at the bottom of the editor; `json-editor-gutter.playwright.ts` also opens it with the
 * editor below the fold, where CodeMirror does not measure on its own.
 */
export default [
  {
    name: 'problem-line',
    host: './json-editor.fixture.svelte',
    props: {
      value: '{\n  "region": "us-west-2",\n  "dryRun": true,\n  "retries": 3,\n}',
    },
  },
  {
    name: 'long-document',
    host: './json-editor.fixture.svelte',
    props: {
      entries: 30,
      rows: 32,
    },
  },
];
