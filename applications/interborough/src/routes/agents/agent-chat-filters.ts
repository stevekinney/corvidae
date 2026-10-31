/**
 * The controls over an agent's chats (state, who started them, a title search, the order) and what
 * each asks of `bureau.contexts.list`. The Bureau applies all of them before it cuts a page.
 */
import type { ContextOrigin } from '../../lib/bureau-client.ts';

/** What the chats are doing now: any, waiting on the person, or running. */
export type ChatState = 'all' | 'needs-you' | 'running';
/** Who started the chats: anyone, the person, a schedule's fire, or a goal. */
export type ChatStartedBy = 'any' | ContextOrigin;
/** The order: last activity, newest started, or oldest started. */
export type ChatSort = 'updated' | 'newest' | 'oldest';

/** The filters of the Chats tab. `title` is the text a title must contain, empty for no filter. */
export interface ChatFilters {
  readonly state: ChatState;
  readonly startedBy: ChatStartedBy;
  readonly title: string;
  readonly sort: ChatSort;
}

/** No filter, newest activity first. */
export const DEFAULT_CHAT_FILTERS: ChatFilters = {
  state: 'all',
  startedBy: 'any',
  title: '',
  sort: 'updated',
};

/** The filter and sort keys of a `bureau.contexts.list` call for `filters`; a filter left off is not sent. */
export function chatListRequest(filters: ChatFilters): {
  readonly origin?: ContextOrigin;
  readonly activity?: 'running' | 'awaiting-input';
  readonly titleContains?: string;
  readonly sortBy: 'updatedAt' | 'createdAt';
  readonly sortOrder: 'asc' | 'desc';
} {
  return {
    ...(filters.startedBy === 'any' ? {} : { origin: filters.startedBy }),
    ...(filters.state === 'all'
      ? {}
      : {
          activity:
            filters.state === 'running' ? ('running' as const) : ('awaiting-input' as const),
        }),
    ...(filters.title === '' ? {} : { titleContains: filters.title }),
    sortBy: filters.sort === 'updated' ? 'updatedAt' : 'createdAt',
    sortOrder: filters.sort === 'oldest' ? 'asc' : 'desc',
  };
}
