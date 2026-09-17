import { fixtureEntry } from './editor-fixture.ts';

export function reviewEditorRoute(slug: string): string {
  const entry = fixtureEntry(slug);
  const fixture = entry.fixtures?.find((candidate) => candidate.name === 'assertion');
  if (fixture === undefined) throw new Error(`Missing review editor fixture for ${slug}.`);
  const parameters = new URLSearchParams({
    fixture: fixture.name,
    fixtureContentHash: fixture.fixtureContentHash,
  });
  return `${entry.route}?${parameters.toString()}`;
}

export const reviewEditorCommentsRoute = reviewEditorRoute('review-editor-comments');
export const reviewEditorReadonlyRoute = reviewEditorRoute('review-editor-readonly');
export const reviewEditorScrollRoute = reviewEditorRoute('review-editor-scroll');
