/**
 * The pending-review panel communicates only with its trusted MCP Apps host.
 */
import type { CatalogTransport } from '@lostgradient/backchannel/client';
import {
  createReviewsClientWithTransport,
  parseReviewsOpeningSnapshot,
  type ReviewsOperationTypes,
} from '@lostgradient/bureau-client/reviews';
import type { ApprovalHost, ApprovalOutcome } from '@lostgradient/bureau-client/reviews/ui';
import { mountPanel } from '@lostgradient/cinder/panel';
import { App } from '@modelcontextprotocol/ext-apps';
import { tick, unmount } from 'svelte';

import { followHostTheme } from '../host-theme.ts';
import { viewReview, type ActionableReview, type Review } from './model.ts';
import Panel from './panel.svelte';
import { readReviewEligibility } from './review-eligibility.ts';
import { createReviewsView, IDLE_ROW, type RowState } from './view.svelte.ts';

const REFRESH_MILLISECONDS = 3000;
const ALLOWED_OPERATIONS = new Set(
  Object.keys(createReviewsClientWithTransport(async () => undefined)),
);

class PanelToolError extends Error {
  constructor(
    message: string,
    readonly data: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function start(): Promise<void> {
  const root = document.getElementById('root');
  if (root === null) return;
  const app = new App({ name: 'bureau-pending-review', version: '1.0.0' });
  const view = createReviewsView();
  const states = view.rows;
  let reviews: Review[] = [];
  let actionable = new Map<string, ActionableReview>();
  let authorizedTargets = new Map<string, number>();
  let connected = true;
  let notice: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let torndown = false;
  let refreshPanel: (() => Promise<void>) | undefined;
  const rowOf = (id: string): RowState => states.get(id) ?? IDLE_ROW;
  const patch = (id: string, change: Partial<RowState>): void => {
    states.set(id, { ...rowOf(id), ...change });
  };
  const canCallServer = (): boolean => app.getHostCapabilities()?.serverTools !== undefined;
  const authorized: ApprovalHost['authorized'] = (review): boolean =>
    !torndown &&
    canCallServer() &&
    actionable.get(review.id)?.round === review.round &&
    (review.effect?.kind !== 'refund' || authorizedTargets.get(review.id) === review.round);

  const transport: CatalogTransport = async (name, input, options) => {
    if (!ALLOWED_OPERATIONS.has(name)) throw new TypeError('Unsupported panel operation');
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new TypeError('Invalid panel operation input');
    const result = await app.callServerTool(
      { name, arguments: Object.fromEntries(Object.entries(input)) },
      options?.signal === undefined ? undefined : { signal: options.signal },
    );
    if (result.isError === true) {
      const fault = result.structuredContent;
      const record =
        fault && typeof fault === 'object' && !Array.isArray(fault)
          ? Object.fromEntries(Object.entries(fault))
          : {};
      const data =
        record['data'] && typeof record['data'] === 'object' && !Array.isArray(record['data'])
          ? Object.fromEntries(Object.entries(record['data']))
          : {};
      throw new PanelToolError(
        typeof record['message'] === 'string'
          ? record['message']
          : 'The host refused the operation.',
        { ...data, ...(typeof record['code'] === 'string' ? { weftCode: record['code'] } : {}) },
      );
    }
    if (name === 'bureau.reviews.list' || name === 'bureau.reviews.get') {
      const metadata = result._meta?.['interborough.reviewEligibility'];
      const targets = readReviewEligibility(metadata);
      if (name === 'bureau.reviews.list') {
        if (!Object.hasOwn(input, 'pageToken')) authorizedTargets = targets;
        else for (const [id, round] of targets) authorizedTargets.set(id, round);
      } else {
        const id = Object.hasOwn(input, 'id') ? Reflect.get(input, 'id') : undefined;
        if (typeof id === 'string') {
          authorizedTargets.delete(id);
          const round = targets.get(id);
          if (round !== undefined) authorizedTargets.set(id, round);
        }
      }
    }
    return result.structuredContent;
  };

  const draw = (announcement: string | null): void => {
    if (torndown) return;
    const now = Date.now();
    view.views = reviews.map((review) => {
      const candidate = actionable.get(review.id);
      const viewed = viewReview(review, now);
      return {
        ...viewed,
        decidable: viewed.decidable && candidate !== undefined && authorized(candidate),
        ...(candidate === undefined ? {} : { actionableReview: candidate }),
      };
    });
    view.notice = notice;
    if (announcement !== null) view.announcement = announcement;
  };

  const adopt = (next: Review[], announceReconnect: boolean, truncated = false): void => {
    if (torndown) return;
    const known = new Set(reviews.map((review) => review.id));
    const arrived = next.filter((review) => !known.has(review.id)).length;
    const gone = reviews.filter(
      (review) =>
        !next.some((other) => other.id === review.id) && rowOf(review.id).outcome === null,
    ).length;
    for (const review of next) {
      const previous = reviews.find((candidate) => candidate.id === review.id);
      if (previous && previous.round !== review.round) states.delete(review.id);
    }
    reviews = next;
    for (const id of states.keys()) {
      if (!next.some((review) => review.id === id) && rowOf(id).outcome === null) states.delete(id);
    }
    notice = canCallServer() ? null : 'This host does not let the page decide; it only lists.';
    if (truncated)
      notice = `${notice === null ? '' : `${notice} `}Showing the ${next.length} oldest pending reviews; decide some to see the rest.`;
    const parts = [
      announceReconnect ? 'Reconnected.' : '',
      arrived > 0 ? `${arrived} new review${arrived === 1 ? '' : 's'}.` : '',
      gone > 0 ? `${gone} no longer pending.` : '',
    ].filter((part) => part !== '');
    draw(parts.length === 0 ? null : parts.join(' '));
  };

  const refresh = async (): Promise<void> => {
    if (!canCallServer() || !refreshPanel || torndown) return;
    try {
      await refreshPanel();
    } catch {
      if (!torndown && connected) {
        authorizedTargets.clear();
        connected = false;
        draw('Connection lost. Retrying.');
      }
    }
  };

  const focusId = async (id: string): Promise<void> => {
    await tick();
    if (!torndown) document.getElementById(id)?.focus();
  };
  const handlers = {
    onOpenReject: (id: string) => {
      patch(id, { rejecting: true });
      draw(null);
      void focusId(`reason-${id}`);
    },
    onCancelReject: (id: string) => {
      patch(id, { rejecting: false, draft: '' });
      draw(null);
      void focusId(`open-${id}`);
    },
    onDraft: (id: string, text: string) => patch(id, { draft: text }),
  };
  const onOutcome = (
    seen: { id: string; round: number },
    outcome: ApprovalOutcome,
    receipt?: ReviewsOperationTypes['bureau.reviews.resolve']['output'],
  ): void => {
    if (torndown || actionable.get(seen.id)?.round !== seen.round) return;
    const message =
      outcome === 'applied'
        ? receipt?.decision === 'approve'
          ? 'Approved.'
          : receipt?.decision === 'reject'
            ? 'Rejected with feedback.'
            : 'Denied.'
        : outcome === 'outcome-not-written'
          ? 'The decision took effect, but its outcome could not be written into the session; check the run.'
          : outcome === 'round-changed' || outcome === 'superseded'
            ? 'This review changed while you read it. Read it again before deciding.'
            : outcome === 'already-resolved'
              ? 'This review is no longer pending.'
              : 'The decision could not be confirmed. Check the queue before deciding again.';
    patch(seen.id, {
      outcome: message,
      ...(outcome === 'applied' || outcome === 'outcome-not-written'
        ? { rejecting: false, draft: '' }
        : {}),
    });
    draw(message);
    void refresh();
  };
  const mounted = mountPanel(Panel, {
    target: root,
    props: {
      view,
      handlers,
      transport,
      authorized,
      onOutcome,
      onReady: (next: () => Promise<void>) => {
        refreshPanel = next;
      },
      onData: (
        page: ReviewsOperationTypes['bureau.reviews.list']['output'],
        truncated: boolean,
      ) => {
        if (torndown) return;
        actionable = new Map(
          page.reviews
            .filter((review): review is ActionableReview => review.kind === 'tool-approval')
            .map((review) => [review.id, review]),
        );
        const wasConnected = connected;
        connected = true;
        adopt(
          page.reviews.filter(
            (review): review is Exclude<typeof review, { kind: 'engine-review' }> =>
              review.kind !== 'engine-review',
          ),
          !wasConnected,
          truncated,
        );
      },
    },
  });
  const applyHostTheme = followHostTheme(app);
  app.ontoolresult = (result) => {
    if (result.isError === true) return;
    const snapshot = parseReviewsOpeningSnapshot(result.structuredContent);
    if (!snapshot) return;
    actionable.clear();
    adopt(
      snapshot.reviews.filter((review) => review.kind !== 'engine-review'),
      false,
    );
    if (canCallServer()) void refresh();
  };
  app.onteardown = async () => {
    torndown = true;
    if (timer !== undefined) clearInterval(timer);
    await unmount(mounted);
    root.replaceChildren();
    return {};
  };
  await app.connect();
  if (torndown) return;
  applyHostTheme();
  await tick();
  await refresh();
  if (torndown) return;
  // poll-reason: mcp-transport
  timer = setInterval(() => void refresh(), REFRESH_MILLISECONDS);
}

void start();
