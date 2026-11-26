import type { CatalogHost } from '@lostgradient/backchannel-svelte';
import type { ReviewsOperationTypes } from '../generated/reviews-operations.generated.ts';
import { validatedReviewsTransport } from './validation.ts';

type DeclaredReview = Extract<
  ReviewsOperationTypes['bureau.reviews.get']['output'],
  { kind: 'tool-approval' }
>;
type OptionalKeys<Value> = {
  [Key in keyof Value]-?: object extends Pick<Value, Key> ? Key : never;
}[keyof Value];
type Review = {
  [
    Key in keyof DeclaredReview as Key extends OptionalKeys<DeclaredReview> ? never : Key
  ]: DeclaredReview[Key];
} & { [Key in OptionalKeys<DeclaredReview>]?: DeclaredReview[Key] | undefined };
type Choice = ReviewsOperationTypes['bureau.reviews.resolve']['input'];
type Receipt = ReviewsOperationTypes['bureau.reviews.resolve']['output'];
export type ApprovalOutcome =
  | 'applied'
  | 'superseded'
  | 'already-resolved'
  | 'round-changed'
  | 'outcome-not-written'
  | 'unknown-after-dispatch'
  | 'failed';
export type ApprovalHost = {
  readonly catalog: CatalogHost;
  readonly authorized: (review: Review) => boolean;
  readonly decisionSurface?: 'reviews' | undefined;
  readonly onOutcome?:
    | ((
        seen: { id: string; round: number },
        outcome: ApprovalOutcome,
        receipt?: Receipt,
        error?: unknown,
      ) => void)
    | undefined;
};
type Target = { busy: boolean; uncertain: boolean; invalid: boolean };
const scopes = new WeakMap<CatalogHost, Map<string, Target>>();

export function useApprovalDecision(host: ApprovalHost) {
  const { catalog, authorized, decisionSurface, onOutcome } = host;
  const call = validatedReviewsTransport((name, input, options) =>
    catalog.call(name, input, options?.signal),
  );
  let targets = scopes.get(catalog);
  if (!targets) {
    targets = new Map();
    scopes.set(catalog, targets);
  }
  const scope = targets;
  return (review: Review) => {
    if (review === null || typeof review !== 'object') throw new TypeError('A review is required');
    const seen = { id: review.id, round: review.round };
    const key = JSON.stringify([seen.id, seen.round]);
    let target = scope.get(key);
    if (!target) {
      const initial = $state({ busy: false, uncertain: false, invalid: false });
      target = initial;
      scope.set(key, target);
    }
    const state = target;
    const actionable = () =>
      !catalog.disposed &&
      typeof review.id === 'string' &&
      review.id.length > 0 &&
      Number.isSafeInteger(review.round) &&
      review.round >= 0 &&
      review.kind === 'tool-approval' &&
      review.approval?.action != null &&
      authorized(review) &&
      review.id === seen.id &&
      review.round === seen.round &&
      review.status === 'pending' &&
      !state.busy &&
      !state.uncertain &&
      !state.invalid &&
      (review.approval.action.type !== 'approval' ||
        !review.approval.action.expiresAt ||
        Date.parse(review.approval.action.expiresAt) > Date.now());
    const mayRemember = () =>
      actionable() && review.effect?.kind !== 'refund' && review.approval.mayRemember === true;
    const report = (
      outcome: ApprovalOutcome,
      captured: Review,
      receipt?: Receipt,
      error?: unknown,
    ) => {
      if (!catalog.disposed && authorized(captured))
        onOutcome?.({ ...seen }, outcome, receipt, error);
    };
    const capture = () => JSON.parse(JSON.stringify(review)) as Review;
    const invalidate = () => catalog.invalidate(['bureau.reviews.list', 'bureau.reviews.get']);
    const read = async () =>
      (await call('bureau.reviews.get', {
        id: seen.id,
      })) as ReviewsOperationTypes['bureau.reviews.get']['output'];
    async function reconcile() {
      if (state.busy || !state.uncertain || catalog.disposed || !authorized(review)) return;
      const captured = capture();
      state.busy = true;
      try {
        const current = await read();
        if (catalog.disposed || !authorized(captured)) return;
        if (
          current.kind !== 'tool-approval' ||
          current.id !== seen.id ||
          current.status !== 'pending' ||
          current.round !== seen.round
        )
          state.invalid = true;
        state.uncertain = false;
        invalidate();
      } finally {
        state.busy = false;
      }
    }
    async function send(choice: Pick<Choice, 'decision' | 'reason' | 'remember'>) {
      if (!actionable() || (choice.remember && !mayRemember())) return;
      const captured = capture();
      state.busy = true;
      let dispatched = false;
      try {
        const current = await read();
        if (catalog.disposed || !authorized(captured)) return;
        if (
          current.kind !== 'tool-approval' ||
          current.id !== seen.id ||
          current.status !== 'pending'
        ) {
          state.invalid = true;
          invalidate();
          report('already-resolved', captured);
          return;
        }
        if (current.round !== seen.round) {
          state.invalid = true;
          invalidate();
          report('round-changed', captured);
          return;
        }
        if (!authorized(current)) return;
        if (
          current.approval.action.type === 'approval' &&
          current.approval.action.expiresAt &&
          !(Date.parse(current.approval.action.expiresAt) > Date.now())
        )
          return;
        if (
          choice.remember &&
          (current.effect?.kind === 'refund' || current.approval.mayRemember !== true)
        )
          return;
        dispatched = true;
        const response = await call('bureau.reviews.resolve', {
          ...seen,
          ...choice,
          ...(decisionSurface ? { decisionSurface } : {}),
        });
        const result = response as Receipt;
        if (
          result.id !== seen.id ||
          result.kind !== 'tool-approval' ||
          result.decision !== choice.decision
        )
          throw new Error('Review decision receipt does not match the command');
        if (result.receipt === 'rejected') {
          state.uncertain = true;
          report('failed', captured);
          return;
        }
        state.invalid = true;
        if (catalog.disposed || !authorized(captured)) return;
        invalidate();
        report(
          result.receipt === 'superseded'
            ? 'superseded'
            : result.warning
              ? 'outcome-not-written'
              : 'applied',
          captured,
          result,
        );
      } catch (error) {
        if (!dispatched) {
          report('failed', captured, undefined, error);
          return;
        }
        state.uncertain = true;
        const data = error && typeof error === 'object' && 'data' in error ? error.data : undefined;
        if (
          (data &&
            typeof data === 'object' &&
            'weftCode' in data &&
            data.weftCode === 'Forbidden') ||
          (error && typeof error === 'object' && 'code' in error && error.code === 'Forbidden')
        ) {
          state.uncertain = false;
          report('failed', captured, undefined, error);
          return;
        }
        const reason =
          data && typeof data === 'object' && 'reason' in data ? data.reason : undefined;
        report(
          reason === 'REVIEW_ROUND_CHANGED'
            ? 'round-changed'
            : reason === 'REVIEW_ALREADY_RESOLVED'
              ? 'already-resolved'
              : reason === 'APPROVAL_OUTCOME_NOT_WRITTEN'
                ? 'outcome-not-written'
                : 'unknown-after-dispatch',
          captured,
          undefined,
          error,
        );
      } finally {
        state.busy = false;
        if (state.uncertain) {
          try {
            await reconcile();
          } catch {
            /* keep the target fenced */
          }
        }
      }
    }
    const reason = (note: string) => note.trim();
    return {
      get disabled() {
        return !actionable();
      },
      get canRemember() {
        return mayRemember();
      },
      approve(note = '') {
        const value = reason(note);
        void send({ decision: 'approve', ...(value ? { reason: value } : {}) });
      },
      remember(note = '') {
        const value = reason(note);
        void send({ decision: 'approve', remember: true, ...(value ? { reason: value } : {}) });
      },
      deny(note = '') {
        const value = reason(note);
        void send(value ? { decision: 'reject', reason: value } : { decision: 'deny' });
      },
      reject(note: string) {
        const value = reason(note);
        if (value) void send({ decision: 'reject', reason: value });
      },
      reconcile,
    };
  };
}
export function useToolApprovalActions(host: ApprovalHost) {
  return useApprovalDecision(host);
}
export type ToolApprovalActions = ReturnType<ReturnType<typeof useToolApprovalActions>>;
