<script lang="ts">
  import {
    addDraftComment,
    clearReviewOutcome,
    clearSession,
    createSession,
    deleteDraftComment,
    fromPersistedSession,
    getDraftCounts,
    setReviewOutcome,
    submitSession,
    toPersistedThreads,
    updateDraftComment,
    validateSessionSchema,
    type PersistedReviewSession,
    type ReviewState,
    generateCommentsExport,
    generateMarkdownSummary,
    generateUnifiedDiff,
  } from '@repo/editor';
  import {
    EDITED_DOCUMENT,
    ORIGINAL_DOCUMENT,
    T_EARLIER,
    T_LATEST,
    T_LATER,
    T_START,
    allIdentical,
    draftReplyComment,
    draftThreadComment,
    keysOf,
    seededThread,
    validationBase,
  } from './state-session-utilities';

  const emptySession = createSession('session-1', T_START);
  const withThreadDraft = addDraftComment(emptySession, draftThreadComment('draft-1', T_LATER));
  const withReplyDraft = addDraftComment(
    withThreadDraft.session,
    draftReplyComment('draft-2', 'thread-release-plan', T_LATER),
  );
  const draftCounts = getDraftCounts(withReplyDraft.session);
  const sessionCounts = `threads=${draftCounts.threads} replies=${draftCounts.replies} total=${draftCounts.total}`;

  const backdated = addDraftComment(emptySession, draftThreadComment('draft-old', T_EARLIER));
  const sessionClamp = `session-updatedAt=${backdated.session.updatedAt} comment-createdAt=${T_EARLIER}`;

  const outcomeFirst = setReviewOutcome(withReplyDraft.session, 'approve', T_LATER);
  const outcomeAgain = setReviewOutcome(outcomeFirst.session, 'approve', T_LATEST);
  const sameOutcome = `changed=${outcomeAgain.changed} same-reference=${outcomeAgain.session === outcomeFirst.session}`;

  const missingDelete = deleteDraftComment(outcomeFirst.session, 'no-such-draft', T_LATEST);
  const missingDraft = `changed=${missingDelete.changed} same-reference=${missingDelete.session === outcomeFirst.session}`;

  const missingUpdate = updateDraftComment(outcomeFirst.session, 'no-such-draft', {
    body: 'ignored',
    updatedAt: T_LATEST,
  });
  const missingUpdateResult = `changed=${missingUpdate.changed} same-reference=${missingUpdate.session === outcomeFirst.session}`;

  const outcomeCleared = clearReviewOutcome(outcomeFirst.session, T_LATEST);
  const clearedOutcomeKeys = `changed=${outcomeCleared.changed} keys=${keysOf(outcomeCleared.session)}`;

  const sessionCleared = clearSession(outcomeFirst.session, T_LATEST);
  const clearedSessionSummary = `changed=${sessionCleared.changed} drafts=${sessionCleared.session.draftComments.length} keys=${keysOf(sessionCleared.session)}`;

  const submitted = submitSession(outcomeFirst.session, 'request_changes', T_LATEST);
  const submittedAgain = submitSession(submitted.session, 'approve', T_LATEST);
  const submitSummary = `changed=${submitted.changed} status=${submitted.session.status} outcome=${submitted.session.outcome} submittedAt=${submitted.session.submittedAt}`;
  const resubmitSummary = `changed=${submittedAgain.changed} outcome=${submittedAgain.session.outcome} same-reference=${submittedAgain.session === submitted.session}`;

  function validationCase(patch: Record<string, unknown>, dropKey?: string): boolean {
    const candidate = { ...validationBase, ...patch };
    if (dropKey) delete candidate[dropKey];
    return validateSessionSchema(candidate);
  }

  const validationMatrix = [
    `base=${validateSessionSchema(validationBase)}`,
    `outcome-undefined=${validationCase({ outcome: undefined })}`,
    `outcome-null=${validationCase({ outcome: null })}`,
    `outcome-unknown=${validationCase({ outcome: 'merge' })}`,
    `outcome-approve=${validationCase({ outcome: 'approve' })}`,
    `status-archived=${validationCase({ status: 'archived' })}`,
    `status-submitted=${validationCase({ status: 'submitted' })}`,
    `no-draftComments=${validationCase({}, 'draftComments')}`,
    `extra-keys=${validationCase({ somethingElse: 'kept', schemaVersion: 99 })}`,
    `not-an-object=${validateSessionSchema('nope')}`,
  ].join(' ');

  const versionedPersisted = {
    ...validationBase,
    schemaVersion: 99,
    draftComments: [],
  } as unknown as PersistedReviewSession;
  const versionedAccepted = `validates=${validateSessionSchema(versionedPersisted)} restored-keys=${keysOf(
    fromPersistedSession(versionedPersisted),
  )}`;

  const exportBaseState: ReviewState = {
    schemaVersion: 4,
    content: EDITED_DOCUMENT,
    original: ORIGINAL_DOCUMENT,
    threads: toPersistedThreads([seededThread()]),
    updatedAt: T_START,
  };
  const versionedStates = [1, 4, 99].map(
    (version) =>
      ({
        ...exportBaseState,
        schemaVersion: version,
      }) as unknown as ReviewState,
  );
  const schemaVersionMatrix = [
    `summary=${allIdentical(versionedStates.map((state) => generateMarkdownSummary(state).markdown))}`,
    `diff=${allIdentical(versionedStates.map((state) => generateUnifiedDiff(state).diff))}`,
    `comments=${allIdentical(versionedStates.map((state) => generateCommentsExport(state).markdown))}`,
  ].join(' ');
</script>

<section style="display: grid; gap: 0.5rem;">
  <h2 style="margin: 0;">Session module (pure, caller-supplies-time)</h2>
  <p data-testid="session-counts" style="margin: 0;">{sessionCounts}</p>
  <p data-testid="session-clamp" style="margin: 0;">{sessionClamp}</p>
  <p data-testid="session-same-outcome" style="margin: 0;">{sameOutcome}</p>
  <p data-testid="session-missing-draft" style="margin: 0;">{missingDraft}</p>
  <p data-testid="session-missing-update" style="margin: 0;">{missingUpdateResult}</p>
  <p data-testid="session-cleared-outcome" style="margin: 0; overflow-wrap: anywhere;">
    {clearedOutcomeKeys}
  </p>
  <p data-testid="session-cleared" style="margin: 0; overflow-wrap: anywhere;">
    {clearedSessionSummary}
  </p>
  <p data-testid="session-submitted" style="margin: 0;">{submitSummary}</p>
  <p data-testid="session-resubmitted" style="margin: 0;">{resubmitSummary}</p>
</section>

<section style="display: grid; gap: 0.5rem;">
  <h2 style="margin: 0;">Schema validation and schemaVersion</h2>
  <p data-testid="validate-matrix" style="margin: 0; overflow-wrap: anywhere;">
    {validationMatrix}
  </p>
  <p data-testid="versioned-accepted" style="margin: 0; overflow-wrap: anywhere;">
    {versionedAccepted}
  </p>
  <p data-testid="schema-version-matrix" style="margin: 0; overflow-wrap: anywhere;">
    {schemaVersionMatrix}
  </p>
</section>
