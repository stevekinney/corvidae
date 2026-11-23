/**
 * The selector of a changed row of Cinder's `JsonDiffViewer` that has no changed row inside it: a
 * leaf. A row of an object holds its children's rows, so a text filter such as `hasText: 'id'`
 * matches the parent that merely contains the word as well as the row it means, and Playwright's
 * strict mode throws before the capture is taken. This is a plain selector, so it works inside a
 * panel's frame as well as on a page.
 */
export const CHANGED_LEAF_ROW =
  '[data-cinder-diff-kind="changed"]:not(:has([data-cinder-diff-kind]))';
