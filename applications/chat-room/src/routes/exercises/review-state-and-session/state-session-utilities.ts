import type { DraftComment, Thread } from '@repo/editor';

export const keysOf = (value: object): string => Object.keys(value).toSorted().join(',');
export const allIdentical = (values: string[]): string =>
  values.every((entry) => entry === values[0]) ? 'identical' : 'differs';

export const ORIGINAL_DOCUMENT = `# Release Plan

The first release includes a dashboard and export actions.`;

export const EDITED_DOCUMENT = `# Release Plan

The first release includes a dashboard, export actions, and inline review.`;

export const T_START = '2026-08-11T09:00:00.000Z';
export const T_EARLIER = '2026-08-11T08:00:00.000Z';
export const T_LATER = '2026-08-11T10:00:00.000Z';
export const T_LATEST = '2026-08-11T11:00:00.000Z';

export function seededThread(): Thread {
  return {
    id: 'thread-release-plan',
    createdAt: T_START,
    anchor: {
      from: 1,
      to: 13,
      quote: 'Release Plan',
      prefix: '# ',
      suffix: '\n\nThe first release',
      status: 'anchored',
      originalQuote: 'Release Plan',
      lastKnownOffset: 0,
    },
    comments: [
      {
        id: 'comment-release-plan',
        threadId: 'thread-release-plan',
        authorId: 'maya',
        body: 'Confirm this title matches the changelog.',
        createdAt: T_START,
      },
    ],
  };
}

export function draftThreadComment(id: string, createdAt: string): DraftComment {
  return {
    id,
    anchor: {
      from: 1,
      to: 13,
      quote: 'Release Plan',
      prefix: '# ',
      suffix: '\n\nThe first release',
      status: 'anchored',
      originalQuote: 'Release Plan',
      lastKnownOffset: 0,
    },
    body: 'Draft comment that would open a new thread.',
    authorId: 'maya',
    createdAt,
    updatedAt: createdAt,
  };
}

export function draftReplyComment(id: string, threadId: string, createdAt: string): DraftComment {
  return {
    id,
    threadId,
    body: 'Draft reply to an existing thread.',
    authorId: 'maya',
    createdAt,
    updatedAt: createdAt,
  };
}

export const validationBase: Record<string, unknown> = {
  id: 'session-1',
  status: 'drafting',
  startedAt: T_START,
  updatedAt: T_START,
  draftComments: [],
};
