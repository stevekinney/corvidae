export const CATALOG_OPERATION_BEHAVIORS = {
  'bureau.reviews.get': {
    mcpExposable: true,
    behavior: {
      kind: 'read',
      key: ['id'],
    },
  },
  'bureau.reviews.list': {
    mcpExposable: true,
    behavior: {
      kind: 'read',
      pagination: {
        items: 'reviews',
        cursorInput: 'pageToken',
        nextCursor: 'nextPageToken',
        total: 'total',
        cursorFilters: ['status', 'resolvedAfter'],
        itemKey: ['source', 'id'],
      },
    },
  },
  'bureau.reviews.resolve': {
    mcpExposable: true,
    behavior: {
      kind: 'command',
      observedInput: {
        read: 'bureau.reviews.get',
        when: {
          kind: 'tool-approval',
          status: 'pending',
        },
        key: 'id',
        revision: 'round',
      },
      invalidates: ['bureau.reviews.list', 'bureau.reviews.get'],
      conflictReasons: [
        'REVIEW_ROUND_CHANGED',
        'REVIEW_ALREADY_RESOLVED',
        'APPROVAL_OUTCOME_NOT_WRITTEN',
      ],
    },
  },
} as const;
