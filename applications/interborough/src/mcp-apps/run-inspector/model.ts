/**
 * The run inspector's view model (COR-910): what `bureau.tasks.inspect` and `bureau.tasks.events`
 * answered, sorted into the sections the page shows. Pure data in, pure data out, so the rules
 * that matter are tested without a browser: transport heartbeat is never progress, a missing
 * liveness is a stated absence, and a stream gap is reported rather than hidden.
 */

/** Evidence sources that show the run did work. Every other source only shows it is reachable. */
const PROGRESS_SOURCES: ReadonlySet<string> = new Set(['tool-progress', 'provider-io']);

/** What `bureau.tasks.inspect` answers. Mirrors the operation's output; unknown fields are ignored. */
export type Inspection = {
  readonly schemaVersion: string;
  readonly taskId: string;
  readonly task: {
    readonly id: string;
    readonly agentName: string | null;
    readonly owner: string;
    readonly status: string;
    readonly finishReason: string | null;
    readonly statusMessage: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly cleanup: string | null;
    readonly openWaits: readonly { readonly kind: string; readonly reviewId: string }[];
  };
  readonly liveness: {
    readonly status: string;
    readonly assessment: string;
    readonly reachability: string;
    readonly progress: string;
    readonly revision: number;
    readonly cancellable: boolean;
    readonly lastHeartbeatAt?: number;
    readonly lastProgressAt?: number;
    readonly declaredWait?: {
      readonly reason: string;
      readonly wakeCondition: string;
      readonly deadline?: number;
      readonly owner?: string;
    };
    readonly semanticProgress?: {
      readonly phase?: string;
      readonly current?: number;
      readonly total?: number;
      readonly unit?: string;
      readonly message?: string;
    };
    readonly evidence: readonly { readonly source: string; readonly at: number }[];
  } | null;
  readonly children: readonly {
    readonly runId: string;
    readonly agentName: string;
    readonly status: string;
    readonly assessment: string | null;
  }[];
};

/** One element of `bureau.tasks.events`. */
export type TaskEventElement = {
  readonly kind: string;
  readonly cursor?: string;
  readonly status?: string;
  readonly artifact?: { readonly text: string; readonly truncated: boolean } | null;
  readonly requestedCursor?: string;
  readonly firstRetainedCursor?: string;
};

/** How the page tells the reader the task's event stream stands. */
export type StreamState =
  | { readonly kind: 'current' }
  | { readonly kind: 'gap'; readonly requestedCursor: string; readonly firstRetainedCursor: string }
  | { readonly kind: 'removed' };

export type InspectorModel = {
  readonly taskId: string;
  readonly agentName: string;
  readonly lifecycle: string;
  readonly liveness: {
    readonly available: boolean;
    readonly assessment: string;
    readonly reachability: string;
    readonly progress: string;
    readonly wait: string | null;
  };
  readonly progressEvidence: readonly { readonly source: string; readonly at: number }[];
  /** Signals that show the run is reachable. They say nothing about whether it is making progress. */
  readonly livenessSignals: readonly { readonly source: string; readonly at: number }[];
  readonly semanticProgress: string | null;
  readonly tree: {
    readonly id: string;
    readonly label: string;
    readonly status: string;
    readonly children: readonly {
      readonly id: string;
      readonly label: string;
      readonly status: string;
    }[];
  };
  readonly result: { readonly text: string; readonly truncated: boolean } | null;
  readonly stream: StreamState;
  readonly abort: {
    readonly available: boolean;
    readonly state: 'running' | 'cancel-requested' | 'cleaning-up' | 'cleaned-up' | 'ended';
    readonly cleanup: string | null;
  };
};

function describeWait(
  wait: NonNullable<Inspection['liveness']>['declaredWait'],
  openWaits: Inspection['task']['openWaits'],
): string | null {
  if (wait !== undefined) return `${wait.reason}: ${wait.wakeCondition}`;
  if (openWaits.length > 0) return `waiting on ${openWaits.length} ${openWaits[0]?.kind ?? 'wait'}`;
  return null;
}

function describeProgress(
  progress: NonNullable<Inspection['liveness']>['semanticProgress'],
): string | null {
  if (progress === undefined) return null;
  const counted =
    progress.current === undefined
      ? ''
      : ` ${progress.current}${progress.total === undefined ? '' : ` of ${progress.total}`}${progress.unit === undefined ? '' : ` ${progress.unit}`}`;
  const parts = [progress.phase, progress.message].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  const text = `${parts.join(': ')}${counted}`.trim();
  return text === '' ? null : text;
}

function abortState(task: Inspection['task']): InspectorModel['abort']['state'] {
  if (task.cleanup === 'cleaned-up') return 'cleaned-up';
  if (task.cleanup === 'cancel-requested') return 'cancel-requested';
  if (task.cleanup === 'cleanup-pending') return 'cleaning-up';
  if (['completed', 'failed', 'canceled'].includes(task.status)) return 'ended';
  return 'running';
}

/** Fold the events the page has read into the stream state and the task's answer. */
export function foldEvents(events: readonly TaskEventElement[]): {
  readonly stream: StreamState;
  readonly result: InspectorModel['result'];
} {
  let stream: StreamState = { kind: 'current' };
  let result: InspectorModel['result'] = null;
  for (const event of events) {
    if (event.kind === 'task.gap') {
      stream = {
        kind: 'gap',
        requestedCursor: event.requestedCursor ?? '',
        firstRetainedCursor: event.firstRetainedCursor ?? '',
      };
    } else if (event.kind === 'task.removed') {
      stream = { kind: 'removed' };
    } else if (event.artifact !== undefined && event.artifact !== null) {
      result = { text: event.artifact.text, truncated: event.artifact.truncated };
    }
  }
  return { stream, result };
}

/** Build the page's model from an inspection and the events read so far. */
export function buildInspectorModel(
  inspection: Inspection,
  events: readonly TaskEventElement[],
): InspectorModel {
  const { task, liveness } = inspection;
  const evidence = liveness?.evidence ?? [];
  const folded = foldEvents(events);
  return {
    taskId: inspection.taskId,
    agentName: task.agentName ?? 'unknown agent',
    lifecycle: task.status,
    liveness: {
      available: liveness !== null,
      assessment: liveness?.assessment ?? 'not observed by this process',
      reachability: liveness?.reachability ?? 'unknown',
      progress: liveness?.progress ?? 'unknown',
      wait: describeWait(liveness?.declaredWait, task.openWaits),
    },
    progressEvidence: evidence.filter((entry) => PROGRESS_SOURCES.has(entry.source)),
    livenessSignals: evidence.filter((entry) => !PROGRESS_SOURCES.has(entry.source)),
    semanticProgress: describeProgress(liveness?.semanticProgress),
    tree: {
      id: task.id,
      label: task.agentName ?? task.id,
      status: task.status,
      children: inspection.children.map((child) => ({
        id: child.runId,
        label: child.agentName,
        status: child.assessment === null ? child.status : `${child.status}, ${child.assessment}`,
      })),
    },
    result: folded.result,
    stream: folded.stream,
    abort: {
      available: liveness?.cancellable === true && abortState(task) === 'running',
      state: abortState(task),
      cleanup: task.cleanup,
    },
  };
}

/**
 * Whether `next` is older than what the page already shows. A refresh that overtakes another, or a
 * host that answers from a replica, can return a snapshot with a lower liveness revision; showing it
 * would move the page backwards.
 */
export function isStaleInspection(shown: Inspection | undefined, next: Inspection): boolean {
  const before = shown?.liveness?.revision;
  const after = next.liveness?.revision;
  return before !== undefined && after !== undefined && after < before;
}
