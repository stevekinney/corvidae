import {
  generateCommentsExport,
  generateMarkdownSummary,
  generateUnifiedDiff,
  type ReviewState,
  type Thread,
} from '@repo/editor';

const formattingOnlyState: ReviewState = {
  schemaVersion: 4,
  content: '* item one\n',
  original: '- item one\n',
  threads: [],
  updatedAt: '2026-08-11T12:00:00.000Z',
};
export const normalizedFormattingOnly = generateUnifiedDiff(formattingOnlyState);
export const rawFormattingOnly = generateUnifiedDiff(formattingOnlyState, {
  normalizeInputs: false,
});
export const formattingOnlySummary = generateMarkdownSummary(formattingOnlyState);
function commentState(anchor: Thread['anchor'], createdAt = '2026-08-11T12:00:00.000Z') {
  return {
    schemaVersion: 4,
    content: 'x',
    threads: [
      {
        id: 'thread-fallback',
        createdAt,
        anchor,
        comments: [
          {
            id: 'comment-fallback',
            threadId: 'thread-fallback',
            authorId: 'maya',
            body: 'note',
            createdAt,
          },
        ],
      },
    ],
    updatedAt: createdAt,
  } satisfies ReviewState;
}
const baseAnchor = {
  from: 0,
  to: 4,
  quote: 'Plan',
  prefix: '',
  suffix: '',
  status: 'anchored',
} as const;
export const locationWithPosition = generateCommentsExport(
  commentState({
    ...baseAnchor,
    lastKnownOffset: 4,
    originalPosition: { offset: 4, line: 3, column: 1 },
  }),
).markdown;
export const locationWithOffset = generateCommentsExport(
  commentState({ ...baseAnchor, lastKnownOffset: 4 }),
).markdown;
export const locationUnknown = generateCommentsExport(commentState({ ...baseAnchor })).markdown;
export const unparseableTimestamp = generateCommentsExport(
  commentState({ ...baseAnchor, lastKnownOffset: 4 }, 'not-a-date'),
).markdown;
export const emptyCommentsExport = generateCommentsExport({
  schemaVersion: 4,
  content: 'x',
  threads: [],
  updatedAt: '2026-08-11T12:00:00.000Z',
}).markdown;
export const allSoftDeletedExport = generateCommentsExport({
  schemaVersion: 4,
  content: 'x',
  threads: [
    {
      id: 'thread-all-deleted',
      createdAt: '2026-08-11T12:00:00.000Z',
      anchor: { ...baseAnchor, lastKnownOffset: 4 },
      comments: [
        {
          id: 'comment-gone',
          threadId: 'thread-all-deleted',
          authorId: 'maya',
          body: 'gone',
          createdAt: '2026-08-11T12:00:00.000Z',
          deletedAt: '2026-08-11T12:01:00.000Z',
        },
      ],
    },
  ],
  updatedAt: '2026-08-11T12:00:00.000Z',
}).markdown;
