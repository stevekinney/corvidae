/**
 * The application fixtures in `fixtures/`, by component, that the editor's browser suite serves.
 * The root suite (`scripts/browser-fixtures`) serves them too, so its component sweep covers them.
 */
export const editorAppFixtureDeclarations = {
  'diff-review': ['assertion'],
  'diff-viewer': ['assertion'],
  'markdown-editor': ['assertion'],
  'markdown-editor-template-placeholders': ['assertion'],
  'review-editor': ['assertion'],
  'review-editor-accessibility': ['assertion'],
  'review-editor-comments': ['assertion'],
  'review-editor-diff-comments': ['assertion'],
  'review-editor-malformed-front-matter': ['assertion'],
  'review-editor-readonly': ['assertion'],
  'review-editor-scroll': ['assertion'],
} as const satisfies Record<string, readonly string[]>;
