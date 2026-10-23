/**
 * The pending-review app's page script (COR-910, 2 of 2), bundled into the `ui://` resource. It
 * talks only to its host over the MCP Apps bridge: it reads the queue through `bureau.reviews.list`
 * and decides through `bureau.reviews.resolve`, so the host's authorization decides every call. It
 * holds no credential and reaches no origin.
 *
 * Each decision is fenced by what the reader saw: the page re-reads the review with
 * `bureau.reviews.get` first and refuses to decide one whose status or round moved on, so a
 * resolved, expired, canceled, or superseded review is never decided on a stale view. A second
 * decision on the same review is answered by the operation as a missing id and shown as refused.
 * Reject-with-feedback is `bureau.reviews.resolve` with `decision: 'reject'` and a `reason`.
 */
import { App } from '@modelcontextprotocol/ext-apps';

import {
  describeResolution,
  describeStatus,
  isOutcomeNotWritten,
  isReview,
  isReviewList,
  type Review,
  viewReview,
} from './model.ts';
import { renderReviews, type ReviewHandlers, type RowState } from './render.ts';

const REFRESH_MILLISECONDS = 3000;
const IDLE: RowState = { busy: false, outcome: null, rejecting: false, draft: '' };

function structured<T>(
  result: { structuredContent?: unknown; isError?: boolean | undefined },
  isShape: (value: unknown) => value is T,
): T | undefined {
  return result.isError !== true && isShape(result.structuredContent)
    ? result.structuredContent
    : undefined;
}

async function start(): Promise<void> {
  const root = document.getElementById('root');
  if (root === null) return;
  const app = new App({ name: 'bureau-pending-review', version: '1.0.0' });
  let reviews: Review[] = [];
  let connected = true;
  let notice: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let torndown = false;
  const states = new Map<string, RowState>();
  const rowOf = (id: string): RowState => states.get(id) ?? IDLE;
  const patch = (id: string, change: Partial<RowState>): void => {
    states.set(id, { ...rowOf(id), ...change });
  };
  const canCallServer = (): boolean => app.getHostCapabilities()?.serverTools !== undefined;

  const draw = (announcement: string | null): void => {
    if (torndown) return;
    const now = Date.now();
    renderReviews(
      root,
      // Without the host's `serverTools` capability no decision can be made, so none is offered.
      reviews.map((review) => {
        const view = viewReview(review, now);
        return { ...view, decidable: view.decidable && canCallServer() };
      }),
      states,
      handlers,
      announcement,
      notice,
    );
  };

  const adopt = (next: Review[], announceReconnect: boolean): void => {
    const known = new Set(reviews.map((review) => review.id));
    const arrived = next.filter((review) => !known.has(review.id)).length;
    // A review this page just decided has said so already; only the others left without a word.
    const gone = reviews.filter(
      (review) =>
        !next.some((other) => other.id === review.id) && rowOf(review.id).outcome === null,
    ).length;
    reviews = next;
    for (const id of states.keys()) {
      if (!next.some((review) => review.id === id) && rowOf(id).outcome === null) states.delete(id);
    }
    notice = canCallServer() ? null : 'This host does not let the page decide; it only lists.';
    const parts = [
      announceReconnect ? 'Reconnected.' : '',
      arrived > 0 ? `${arrived} new review${arrived === 1 ? '' : 's'}.` : '',
      gone > 0 ? `${gone} no longer pending.` : '',
    ].filter((part) => part !== '');
    draw(parts.length === 0 ? null : parts.join(' '));
  };

  const lost = (): void => {
    if (connected) {
      connected = false;
      draw('Connection lost. Retrying.');
    }
  };

  const refresh = async (): Promise<void> => {
    if (!canCallServer()) return;
    try {
      const listed = structured(
        await app.callServerTool({ name: 'bureau.reviews.list', arguments: {} }),
        isReviewList,
      );
      if (listed === undefined) return lost();
      const wasConnected = connected;
      connected = true;
      adopt(listed.reviews, !wasConnected);
    } catch {
      lost();
    }
  };

  const decide = async (
    seen: Review,
    decision: 'approve' | 'deny' | 'reject',
    reason?: string,
  ): Promise<string> => {
    const current = structured(
      await app.callServerTool({ name: 'bureau.reviews.get', arguments: { id: seen.id } }),
      isReview,
    );
    if (current === undefined) return 'This review is no longer available. It was not decided.';
    if (current.status !== 'pending') {
      return `This review is ${describeStatus(current.status)}. It was not decided.`;
    }
    if ((current.round ?? 0) !== (seen.round ?? 0)) {
      reviews = reviews.map((review) => (review.id === seen.id ? current : review));
      return 'This review changed while you read it. Read it again before deciding.';
    }
    const receipt = await app.callServerTool({
      name: 'bureau.reviews.resolve',
      arguments: { id: seen.id, decision, ...(reason === undefined ? {} : { reason }) },
    });
    // The decision took effect and only the write of its outcome failed: it is not a refusal.
    if (receipt.isError === true && isOutcomeNotWritten(receipt)) {
      return `${describeResolution(decision, 'applied')} Warning: the outcome could not be written into the session; check the run.`;
    }
    const answer = receipt.isError === true ? undefined : receipt.structuredContent;
    return typeof answer === 'object' && answer !== null && 'receipt' in answer
      ? describeResolution(decision, String(answer.receipt))
      : 'The decision was refused: the review was already decided or is not yours to decide.';
  };

  const resolve = async (
    id: string,
    decision: 'approve' | 'deny' | 'reject',
    reason?: string,
  ): Promise<void> => {
    const seen = reviews.find((review) => review.id === id);
    if (seen === undefined || rowOf(id).busy || !canCallServer()) return;
    patch(id, { busy: true, outcome: null });
    draw(null);
    let outcome: string;
    try {
      outcome = await decide(seen, decision, reason);
    } catch {
      outcome = 'The host did not answer. Check the queue before deciding again.';
    }
    patch(id, { busy: false, outcome, rejecting: false, draft: '' });
    draw(outcome);
    await refresh();
  };

  const focusKey = (key: string): void => {
    [...root.querySelectorAll<HTMLElement>('[data-focus]')]
      .find((candidate) => candidate.getAttribute('data-focus') === key)
      ?.focus();
  };

  const handlers: ReviewHandlers = {
    onDecide: (id, decision) => void resolve(id, decision),
    onOpenReject: (id) => {
      patch(id, { rejecting: true });
      draw(null);
      focusKey(`reason:${id}`);
    },
    onCancelReject: (id) => {
      patch(id, { rejecting: false, draft: '' });
      draw(null);
      focusKey(`open:${id}`);
    },
    onDraft: (id, text) => patch(id, { draft: text }),
    onReject: (id) => {
      const reason = rowOf(id).draft.trim();
      if (reason !== '') void resolve(id, 'reject', reason);
    },
  };

  // The result that opened the page is its first render, whether or not the host lets it call back.
  app.ontoolresult = (result) => {
    const listed = structured(result, isReviewList);
    if (listed !== undefined) adopt(listed.reviews, false);
  };
  // Closing the page releases only this page's observation: nothing is decided.
  app.onteardown = async () => {
    torndown = true;
    if (timer !== undefined) clearInterval(timer);
    root.replaceChildren();
    return {};
  };
  await app.connect();
  // A host that does not hand the page the opening result still shows the queue at once.
  await refresh();
  timer = setInterval(() => void refresh(), REFRESH_MILLISECONDS);
}

void start();
