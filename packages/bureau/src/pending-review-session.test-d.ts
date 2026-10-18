// Type-level tripwire (COR-1577): only a human wait can lack a session. A tool approval always
// belongs to one, and `SessionPendingReview` is the type Bureau's session code works in, so a
// session's `sessionId` stays `string` there.

import type {
  PendingHumanWaitReview,
  PendingReview,
  PendingToolApprovalReview,
  SessionPendingReview,
} from './types';

declare const approval: PendingToolApprovalReview;
export const approvalSession: string = approval.sessionId;

declare const wait: PendingHumanWaitReview;
// @ts-expect-error -- a catalog run's human wait has no session, so this may be undefined
export const waitSession: string = wait.sessionId;
export const maybeWaitSession: string | undefined = wait.sessionId;

declare const session: SessionPendingReview;
export const sessionReviewSession: string = session.sessionId;

declare const any: PendingReview;
// @ts-expect-error -- the public union includes the human wait with no session
export const anySession: string = any.sessionId;
