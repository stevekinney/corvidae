import {
  deleteComment,
  deleteThread,
  updateComment,
  type Comment,
  type Thread,
} from '@repo/editor';

type ReducerProbeResult = {
  defaulted: {
    changed: boolean;
    deletedAt: string | null;
    withinCallWindow: boolean;
  };
  explicit: {
    changed: boolean;
    deletedAt: string | null;
  };
  repeated: {
    changed: boolean;
    keptIdentity: boolean;
    deletedAt: string | null;
  };
  unknown: {
    deleteCommentUnknownThreadChanged: boolean;
    deleteCommentUnknownCommentChanged: boolean;
    updateCommentUnknownThreadChanged: boolean;
    updateCommentUnknownCommentChanged: boolean;
    deleteThreadUnknownChanged: boolean;
    updateKeptIdentity: boolean;
    deleteThreadKeptIdentity: boolean;
  };
  hard: {
    changed: boolean;
    comments: number;
  };
  positive: {
    deleteThreadChanged: boolean;
    updateCommentChanged: boolean;
  };
};

const EXPLICIT_REDUCER_STAMP = '2019-03-04T05:06:07.008Z';

function reducerProbeFixture(): Thread[] {
  return [
    {
      id: 't-solo',
      createdAt: '2026-08-01T09:00:00.000Z',
      anchor: {
        type: 'document',
        from: 0,
        to: 0,
        quote: '',
        prefix: '',
        suffix: '',
        status: 'anchored',
      },
      comments: [
        {
          id: 'c-solo',
          threadId: 't-solo',
          authorId: 'steve',
          body: 'Only comment.',
          createdAt: '2026-08-01T09:00:00.000Z',
        },
      ],
    },
  ];
}

function firstReducerComment(source: Thread[]): Comment | undefined {
  return source[0]?.comments[0];
}

function softDeleteDefaultProbe(): ReducerProbeResult['defaulted'] {
  const before = Date.now();
  const result = deleteComment(reducerProbeFixture(), 't-solo', 'c-solo', { soft: true });
  const after = Date.now();
  const deletedAt = firstReducerComment(result.threads)?.deletedAt ?? null;

  return {
    changed: result.changed,
    deletedAt,
    withinCallWindow:
      deletedAt !== null && Date.parse(deletedAt) >= before && Date.parse(deletedAt) <= after,
  };
}

function explicitSoftDeleteProbe(): ReducerProbeResult['explicit'] {
  const result = deleteComment(reducerProbeFixture(), 't-solo', 'c-solo', {
    soft: true,
    deletedAt: EXPLICIT_REDUCER_STAMP,
  });

  return {
    changed: result.changed,
    deletedAt: firstReducerComment(result.threads)?.deletedAt ?? null,
  };
}

function repeatedSoftDeleteProbe(): ReducerProbeResult['repeated'] {
  const alreadyDeleted = deleteComment(reducerProbeFixture(), 't-solo', 'c-solo', {
    soft: true,
    deletedAt: EXPLICIT_REDUCER_STAMP,
  }).threads;
  const repeated = deleteComment(alreadyDeleted, 't-solo', 'c-solo', { soft: true });

  return {
    changed: repeated.changed,
    keptIdentity: repeated.threads === alreadyDeleted,
    deletedAt: firstReducerComment(repeated.threads)?.deletedAt ?? null,
  };
}

function unknownReducerProbe(): ReducerProbeResult['unknown'] {
  const fixtureThreads = reducerProbeFixture();
  const deleteCommentUnknownThread = deleteComment(fixtureThreads, 't-nope', 'c-solo', {
    soft: true,
  });
  const deleteCommentUnknownComment = deleteComment(fixtureThreads, 't-solo', 'c-nope', {
    soft: true,
  });
  const updateCommentUnknownThread = updateComment(fixtureThreads, 't-nope', 'c-solo', {
    body: 'Never applied.',
    editedAt: EXPLICIT_REDUCER_STAMP,
  });
  const updateCommentUnknownComment = updateComment(fixtureThreads, 't-solo', 'c-nope', {
    body: 'Never applied.',
    editedAt: EXPLICIT_REDUCER_STAMP,
  });
  const deleteThreadUnknown = deleteThread(fixtureThreads, 't-nope');

  return {
    deleteCommentUnknownThreadChanged: deleteCommentUnknownThread.changed,
    deleteCommentUnknownCommentChanged: deleteCommentUnknownComment.changed,
    updateCommentUnknownThreadChanged: updateCommentUnknownThread.changed,
    updateCommentUnknownCommentChanged: updateCommentUnknownComment.changed,
    deleteThreadUnknownChanged: deleteThreadUnknown.changed,
    updateKeptIdentity: updateCommentUnknownThread.threads === fixtureThreads,
    deleteThreadKeptIdentity: deleteThreadUnknown.threads === fixtureThreads,
  };
}

function hardDeleteProbe(): ReducerProbeResult['hard'] {
  const result = deleteComment(reducerProbeFixture(), 't-solo', 'c-solo', { soft: false });

  return {
    changed: result.changed,
    comments: result.threads[0]?.comments.length ?? -1,
  };
}

function positiveReducerProbe(): ReducerProbeResult['positive'] {
  const fixtureThreads = reducerProbeFixture();

  return {
    deleteThreadChanged: deleteThread(fixtureThreads, 't-solo').changed,
    updateCommentChanged: updateComment(fixtureThreads, 't-solo', 'c-solo', {
      body: 'Applied.',
      editedAt: EXPLICIT_REDUCER_STAMP,
    }).changed,
  };
}

export function runReducerProbeResult(): ReducerProbeResult {
  return {
    defaulted: softDeleteDefaultProbe(),
    explicit: explicitSoftDeleteProbe(),
    repeated: repeatedSoftDeleteProbe(),
    unknown: unknownReducerProbe(),
    hard: hardDeleteProbe(),
    positive: positiveReducerProbe(),
  };
}
