/**
 * What the Workers page says (COR-2018, rows 78g to 79i, 78q to 78u, 79a to 79e): the list pane,
 * the open worker's header and notice, the tasks on its queue, and the two confirmations. The
 * words are the agreed design's, so a change here is a change to the design.
 */

/** "1 task", "2 tasks". */
function tasks(count: number): string {
  return `${String(count)} ${count === 1 ? 'task' : 'tasks'}`;
}

/**
 * What stays on the queue when its worker is forgotten: "The 12 waiting tasks and the 2 that failed
 * for good stay on the reports queue and continue when a reports worker connects."
 */
function forgetHeldLine(queue: string, waiting: number, failed: number): string {
  if (waiting === 0 && failed === 0) return `Nothing is waiting on the ${queue} queue.`;
  const subjects = [
    ...(waiting > 0 ? [`the ${String(waiting)} waiting ${waiting === 1 ? 'task' : 'tasks'}`] : []),
    ...(failed > 0 ? [`the ${String(failed)} that failed for good`] : []),
  ];
  const plural = subjects.length > 1 || waiting + failed > 1;
  const subject = subjects.join(' and ');
  return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${plural ? 'stay' : 'stays'} on the ${queue} queue and ${plural ? 'continue' : 'continues'} when a ${queue} worker connects.`;
}

export const WORKER_COPY = {
  list: {
    title: 'Workers',
    detailLabel: 'Worker',
    filterLabel: 'Filter workers',
    filterPlaceholder: 'Filter workers',
    emptyTitle: 'No workers connected',
    emptyDescription: 'Connect a remote worker to this queue to see it here.',
    noMatchTitle: (filter: string): string => `No workers match “${filter}”`,
    noMatchDescription: 'Workers are matched by name and queue.',
    clearFilter: 'Clear filter',
    /** Line two of a row, by how the worker stands. */
    meta: {
      connected: (queue: string, running: number): string =>
        `${queue} · ${String(running)} running`,
      disconnected: (queue: string): string => `${queue} queue`,
      draining: (running: number): string => `Finishing ${tasks(running)}, then stops`,
      stopped: (finished: number): string => `Drained · finished its ${tasks(finished)}`,
    },
    /** What the empty detail pane says while no worker is open. */
    pickTitle: 'Choose a worker',
    pickDescription: 'Choose a worker from the list to see its queue, tasks, and what it serves.',
    closedTitle: 'Worker closed',
    closedDescription: (id: string): string =>
      `No worker with the ID ${id} is listed by the server. It was forgotten, or it never connected here.`,
    backToList: 'Back to all workers',
  },
  detail: {
    forget: 'Forget this worker',
    drain: 'Drain this worker',
    resume: 'Resume this worker',
    copy: 'Copy',
    copyLabel: 'Copy the worker ID',
    copied: 'Copied',
    status: {
      connected: 'Connected',
      draining: 'Draining',
      disconnected: 'Disconnected',
      stopped: 'Stopped',
    },
    /** The sentence after the status word. */
    statusLine: {
      lastHeard: (when: string): string => `Last heard from ${when}`,
      draining: (running: number): string => `Finishing ${tasks(running)}, then it stops.`,
      stopped: (finished: number): string =>
        `It finished its ${tasks(finished)} and stopped. Nothing is waiting on it.`,
    },
    /** The amber notice on a worker that went away and left its queue with nobody. */
    notice: {
      lead: (queue: string): string => `Nothing is running the ${queue} queue.`,
      body: (queue: string, waiting: number, failed: number): string => {
        const counted = [
          waiting > 0 ? `${tasks(waiting)} ${waiting === 1 ? 'is' : 'are'} waiting for it` : '',
          failed > 0 ? `${String(failed)} failed for good` : '',
        ].filter((part) => part !== '');
        const lead =
          counted.length === 0
            ? ''
            : `${counted.join(' and ')}. They continue when a ${queue} worker connects. `;
        return `${lead}Start the worker process again on its machine; it reconnects by itself.`;
      },
    },
    facts: {
      queues: 'Queues',
      running: 'Running now',
      serves: 'Serves',
      version: 'Version',
      none: '—',
      runningValue: (count: number): string => tasks(count),
    },
  },
  tasks: {
    heading: (queue: string): string => `Tasks on the ${queue} queue`,
    tabsLabel: 'Tasks on this queue',
    all: 'All',
    waiting: 'Waiting',
    failed: 'Failed for good',
    retryAll: (count: number): string => `Retry all (${String(count)})`,
    retrying: (count: number): string => `Retrying ${String(count)}…`,
    clearAll: (count: number): string => `Clear all (${String(count)})`,
    retry: 'Retry',
    clear: 'Clear',
    viewPayload: 'View payload',
    payloadTitle: (task: string): string => `Payload of ${task}`,
    payloadLabel: 'Payload',
    runLink: (workflow: string): string => `${workflow} run`,
    forThe: 'for the',
    failedLine: (attempts: number, cause: string): string =>
      `Failed after ${String(attempts)} ${attempts === 1 ? 'try' : 'tries'} · ${cause}`,
    unknownCause: 'Its result could not be saved.',
    waitingLine: (queue: string): string => `On the ${queue} queue · waiting for a ${queue} worker`,
    backLine: (attempt: number): string => `Back on the queue · try ${String(attempt)}`,
    footnote:
      'Retry puts a task back on the queue. Clear removes the task and its payload; an Undo toast follows.',
    showing: 'waiting tasks',
    loadMore: 'Load more',
    emptyFailed: (waiting: number): string =>
      waiting === 0 ? 'No failed tasks.' : `No failed tasks. ${String(waiting)} are still waiting.`,
    emptyWaiting: (failed: number): string =>
      failed === 0
        ? 'No tasks are waiting.'
        : `No tasks are waiting. ${String(failed)} failed for good.`,
    emptyAll: 'No tasks on this queue.',
    cleared: (count: number, queue: string): string =>
      `Cleared ${String(count)} failed ${count === 1 ? 'task' : 'tasks'} from the ${queue} queue.`,
    retried: (count: number, queue: string): string =>
      `Put ${String(count)} ${count === 1 ? 'task' : 'tasks'} back on the ${queue} queue. ${count === 1 ? 'It runs' : 'They run'} when a ${queue} worker connects.`,
    loadFailure: 'Couldn’t load the tasks on this queue.',
    tryAgain: 'Try again',
  },
  drain: {
    title: (name: string): string => `Drain ${name}?`,
    confirm: 'Drain worker',
    body: (running: number, queue: string, successor: string | null): string => {
      const own =
        running === 0
          ? 'It takes no new tasks, and then stops.'
          : `It finishes the ${tasks(running)} it is running, takes no new ones, and then stops.`;
      const rest =
        successor === null
          ? `New ${queue} tasks wait until a ${queue} worker connects.`
          : `New ${queue} tasks go to ${successor}.`;
      return `${own} ${rest}`;
    },
    others: (queue: string): string => `the other ${queue} workers`,
  },
  forget: {
    title: (name: string): string => `Forget ${name}?`,
    confirm: 'Forget worker',
    body: (queue: string, waiting: number, failed: number): string =>
      `Interborough stops listing it. ${forgetHeldLine(queue, waiting, failed)} If the worker is still running, it shows up again the next time it checks in.`,
  },
} as const;
