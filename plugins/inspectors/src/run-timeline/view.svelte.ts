import type { TimelineModel } from './model.ts';

/**
 * Where the page stands: `loading` until the first read answers, `ready` with a timeline,
 * `unreadable` when the host answered that the run could not be read, and `offline` when the host
 * does not let the page call a tool and no result opened it.
 */
type TimelinePhase = 'loading' | 'ready' | 'unreadable' | 'offline';

/**
 * How the page's reads are going once it shows a timeline: `ok`, `lost` while the host does not
 * answer (what is shown may be out of date), and `back` for a while after it answers again.
 */
type TimelineConnection = 'ok' | 'lost' | 'back';

/** What the run timeline shows, and what it has just said to the live region. */
export type TimelineView = {
  phase: TimelinePhase;
  connection: TimelineConnection;
  /** The run as the page last read it, or `undefined` until the first read. */
  model: TimelineModel | undefined;
  /** What the polite live region says now. It outlives every change of the model. */
  announcement: string;
};

/** A view the page updates and the component reads: a change to any field redraws the page. */
export function createTimelineView(): TimelineView {
  const view: TimelineView = $state({
    phase: 'loading',
    connection: 'ok',
    model: undefined,
    announcement: '',
  });
  return view;
}
