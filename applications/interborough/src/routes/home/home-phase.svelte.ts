/**
 * Which page Home draws around its cards: the placeholders while the first reads are out, the page
 * itself once they have answered, the page that says a slow load was canceled, or the full error
 * state when the server does not answer and nothing has loaded. The cards each read on their own;
 * this is only the frame that holds them.
 *
 * Home is `loading` until the reads that decide its shape have answered (the first-run answers
 * `useHomeFirstRun` reads, then, for the overview, the problems and the reviews), so a card never
 * draws empty and fills in: nothing moves when data arrives. The placeholders appear after 300 ms
 * and say so after 10 s, with a way to cancel; those two timings are Cinder `skeleton`'s own
 * (`home-loading.svelte`). Canceling asks the reads to stop and shows "Loading canceled" until the
 * person tries again.
 *
 * Nothing loaded and the server not answering is the full error state, drawn instead of the
 * shell's banner (`ConnectionMonitor.shownInPlace`): a banner says the data on screen is old, and
 * there is none. Once any read has answered the page is drawn from what it holds and a banner says
 * how old that is.
 */
import { useQueryClient } from '@tanstack/svelte-query';

import { getConnection } from '../../app/connection.svelte.ts';
import { isNetworkFailure } from '../../lib/faults.ts';
import { queryKeys } from '../../lib/query.ts';
import { waitingReviewsQuery } from '../reviews/reviews-data.ts';
import type { HomeFirstRun } from './home-first-run.svelte.ts';
import {
  useAgentList,
  useAttentionItems,
  useChatHistory,
  useHostProviders,
  useRecentChats,
} from './home-queries.svelte.ts';
import { RECENT_CHAT_LIMIT } from './home-rows.ts';

/** What Home draws around its cards. */
export type HomePhase = 'loading' | 'canceled' | 'unreachable' | 'ready';

/** Home's phase, and the two things a person can do about it. */
export interface HomePhaseState {
  /** Which page Home draws. */
  phase(): HomePhase;
  /** Stops the reads that are out and shows "Loading canceled". */
  cancel(): void;
  /** Asks the reads again: Try again after a cancel, and after the full error state. */
  retry(): void;
}

/** The keys of the reads Home waits on, so a cancel can stop them. */
const WAITED_ON_KEYS = [
  queryKeys.hostProviders(),
  queryKeys.agents.list(),
  queryKeys.contexts.recent(RECENT_CHAT_LIMIT),
  queryKeys.contexts.firstRun(),
  queryKeys.bureauAttention.items(),
  queryKeys.reviews.inbox('pending'),
] as const;

/** Reads Home's phase from its first-run state and its own reads. Call it while a component initializes. */
export function useHomePhase(firstRun: HomeFirstRun): HomePhaseState {
  const queryClient = useQueryClient();
  const connection = getConnection();
  const providers = useHostProviders();
  const agents = useAgentList();
  const chats = useRecentChats();
  // The first-run checklist's own read of whether a chat happened, asked again with the rest.
  const history = useChatHistory();
  const attention = useAttentionItems();
  const reviews = waitingReviewsQuery();

  let canceled = $state(false);
  // Once the page has been drawn from what it read, it stays drawn: a read asked again (a Try again
  // on one card) must not take the page away.
  let revealed = $state(false);

  const settled = (query: { isSuccess: boolean; isError: boolean }): boolean =>
    query.isSuccess || query.isError;
  const nothingLoaded = $derived(
    providers.data === undefined &&
      agents.data === undefined &&
      chats.data === undefined &&
      attention.data === undefined &&
      reviews.data === undefined,
  );
  // The server did not answer: the shell says so, or a read that has failed got no answer at all.
  const serverSilent = $derived(
    connection.unreachable ||
      [providers, agents, chats, attention, reviews].some(
        (query) => query.isError && isNetworkFailure(query.error),
      ),
  );
  const answered = $derived(
    firstRun.mode() === 'pending'
      ? // The first-run answers are in, or failed: a chat list that cannot be read shows the overview.
        false
      : firstRun.mode() === 'checklist' || (settled(attention) && settled(reviews)),
  );

  $effect.pre(() => {
    if (answered && !revealed) revealed = true;
  });

  const phase = $derived<HomePhase>(
    nothingLoaded && serverSilent && (connection.unreachable || settled(chats))
      ? 'unreachable'
      : revealed
        ? 'ready'
        : canceled
          ? 'canceled'
          : 'loading',
  );

  return {
    phase: () => phase,
    cancel: () => {
      canceled = true;
      for (const queryKey of WAITED_ON_KEYS) void queryClient.cancelQueries({ queryKey });
    },
    retry: () => {
      canceled = false;
      if (connection.unreachable) void connection.retryNow();
      for (const query of [providers, agents, chats, history, attention, reviews]) {
        void query.refetch();
      }
    },
  };
}
