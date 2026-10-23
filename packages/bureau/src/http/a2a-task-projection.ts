/**
 * How a Bureau task reads as an A2A 1.0.1 `Task` (COR-903).
 *
 * | Bureau task | A2A state |
 * | --- | --- |
 * | `submitted` (admitted, not yet started) | `TASK_STATE_SUBMITTED` |
 * | `working` (running, aborting, cleaning up) | `TASK_STATE_WORKING` |
 * | `input-required` (a human wait, or an approval the requester decides) | `TASK_STATE_INPUT_REQUIRED` |
 * | `completed` | `TASK_STATE_COMPLETED`, with the reply as its status message and one artifact |
 * | `failed` | `TASK_STATE_FAILED`, with the reason as its status message |
 * | `canceled` | `TASK_STATE_CANCELED` |
 *
 * `TASK_STATE_AUTH_REQUIRED` is not produced: no Bureau wait asks for a credential yet. A refusal
 * at admission is an error to the send, so no task exists to read as `TASK_STATE_REJECTED`.
 *
 * `history` is the task's own A2A history from its A2A record, never the session transcript, and
 * nothing a run sees internally (its system prompt, tools, or memory) reaches a projected task.
 *
 * @module a2a-task-projection
 */

import { type Artifact, Message, type Part, Role, type Task, TaskState } from '@a2a-js/sdk';
import type {
  TaskCleanupAcknowledgement,
  TaskOpenWait,
  TaskState as BureauTaskState,
  TaskView,
} from '../task-registry.ts';
import { TASK_ARTIFACT_TEXT_LIMIT } from '../task-registry.ts';
import { formSurfaceId, previousParkReviewId, type WaitForm } from './a2a-input-forms.ts';
import { A2UI_MEDIA_TYPE, inputFormDeletion, inputFormMessages } from '../a2ui/input-form.ts';
import { A2UI_EXTENSION_URI, offeredCatalogIds } from '../a2ui/catalogs.ts';
import { a2uiMessagesOf } from '../a2ui/messages.ts';
import type { InteractiveSurface } from '../interactive-surface/types.ts';
import type { A2ATaskRecord, A2AWireMessage } from './a2a-task-record.ts';

/** The cleanup extension's URI (`packages/weft/documentation/a2a/extensions/cleanup-v1.md`). */
export const CLEANUP_EXTENSION_URI =
  'https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/cleanup-v1.md';

/** The identifier of the artifact a completed task's reply is published as. */
export function resultArtifactId(taskId: string): string {
  return `${taskId}:result`;
}

const STATES: Readonly<Record<BureauTaskState, TaskState>> = {
  submitted: TaskState.TASK_STATE_SUBMITTED,
  working: TaskState.TASK_STATE_WORKING,
  'input-required': TaskState.TASK_STATE_INPUT_REQUIRED,
  completed: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  canceled: TaskState.TASK_STATE_CANCELED,
};

/** The A2A state a Bureau task in `state` reads as. */
export function a2aStateOf(state: BureauTaskState): TaskState {
  return STATES[state];
}

/** The Bureau state an A2A `ListTasks` status filter names, or `undefined` for none. */
export function bureauStateOf(state: TaskState): BureauTaskState | undefined {
  for (const [bureau, a2a] of Object.entries(STATES) as [BureauTaskState, TaskState][]) {
    if (a2a === state) return bureau;
  }
  return undefined;
}

const TERMINAL: ReadonlySet<BureauTaskState> = new Set(['completed', 'failed', 'canceled']);

/** Whether a Bureau task in `state` can change no further. */
export function isTerminal(state: BureauTaskState): boolean {
  return TERMINAL.has(state);
}

/** Whether a blocking `SendMessage` returns at `state`: terminal, or waiting on its requester. */
export function isSettled(state: BureauTaskState): boolean {
  return isTerminal(state) || state === 'input-required';
}

/** A text part. */
export function textPart(text: string): Part {
  return {
    content: { $case: 'text', value: text },
    metadata: undefined,
    filename: '',
    mediaType: '',
  };
}

/**
 * The parts of an agent's reply on a completed task (COR-788): its text, and its generated media
 * as file parts whose `url` is the asset route (or, for a small JSON asset, a data part). Empty
 * when the reply holds nothing.
 */
export type ReplyParts = readonly Part[];

/**
 * The parts a completed task publishes. With a reply, its parts as they are: media whole, and its
 * text parts bounded together by one {@link TASK_ARTIFACT_TEXT_LIMIT} budget. Without one, the
 * answer text the task registry recorded, as one text part.
 */
export function publishedReplyParts(
  reply: ReplyParts | undefined,
  recordedText?: string,
): ReplyParts {
  if (reply === undefined) {
    return recordedText === undefined || recordedText === '' ? [] : [textPart(recordedText)];
  }
  let budget = TASK_ARTIFACT_TEXT_LIMIT;
  return reply.flatMap((part) => {
    if (part.content?.$case !== 'text') return [part];
    const text = part.content.value.slice(0, budget);
    budget -= text.length;
    return text === '' ? [] : [{ ...part, content: { $case: 'text' as const, value: text } }];
  });
}

/** An agent message on a task: a text, or the given parts. */
export function agentMessage(
  task: { readonly id: string; readonly contextId: string },
  messageId: string,
  content: string | ReplyParts,
  metadata?: Record<string, unknown>,
): Message {
  return {
    messageId,
    contextId: task.contextId,
    taskId: task.id,
    role: Role.ROLE_AGENT,
    parts: typeof content === 'string' ? [textPart(content)] : [...content],
    metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

/** The identifier of the agent's reply on a task, stable so a re-read never mints another. */
export function replyMessageId(taskId: string): string {
  return `${taskId}:reply`;
}

/** What an `INPUT_REQUIRED` task's status message names, so a continuation can address it. */
export function waitingMessage(view: TaskView, forms: readonly WaitForm[] = []): Message {
  const signalNames = view.openWaits
    .filter(
      (wait): wait is Extract<TaskOpenWait, { kind: 'human-wait' }> => wait.kind === 'human-wait',
    )
    .map((wait) => wait.signalName);
  const callIds = view.openWaits
    .filter(
      (wait): wait is Extract<TaskOpenWait, { kind: 'tool-approval' }> =>
        wait.kind === 'tool-approval',
    )
    .map((wait) => wait.callId);
  let text =
    callIds.length > 0 && signalNames.length === 0
      ? 'Waiting for an approval: answer with a data part {"decision": "approve" | "deny" | "reject"}.'
      : 'Waiting for input: answer with a message; name the wait in metadata.signalName when several are open.';
  if (forms.length > 0) {
    // A wait with an input schema is answered with the form's values, not with text: the prompt
    // tells a client without A2UI what is asked, and the form parts render it for one with.
    const prompts = forms.flatMap((form) => (form.prompt === undefined ? [] : [form.prompt]));
    text = [
      ...prompts,
      "Answer with a data part holding the form's values as one JSON object keyed by field name; name the wait in metadata.signalName when several are open.",
    ].join('\n');
  }
  const message = agentMessage(view, `${view.id}:waiting:${view.updatedAt}`, text, {
    ...(signalNames.length === 0 ? {} : { signalNames }),
    ...(callIds.length === 0 ? {} : { callIds }),
  });
  // One data part per form, carrying its A2UI messages as an array (the A2UI extension's data
  // encoding). A repeated wait on a signal is a new surface: the earlier park's closes first.
  for (const form of forms) {
    const previous = previousParkReviewId(form.reviewId);
    message.parts.push({
      content: {
        $case: 'data',
        value: [
          ...(previous === undefined ? [] : [inputFormDeletion(formSurfaceId(previous))]),
          ...inputFormMessages(formSurfaceId(form.reviewId), form.inputSchema),
        ],
      },
      metadata: { mimeType: A2UI_MEDIA_TYPE },
      filename: '',
      mediaType: A2UI_MEDIA_TYPE,
    });
  }
  return message;
}

/** The cleanup extension's namespace for a task, or `undefined` when it has nothing to report. */
export function cleanupMetadataOf(
  view: TaskView,
  acknowledgement: TaskCleanupAcknowledgement | undefined,
): Record<string, unknown> | undefined {
  const namespace: Record<string, unknown> = {};
  if (view.cleanup !== null) {
    const settled =
      view.cleanup === 'cleaned-up' ||
      view.cleanup === 'cleanup-failed' ||
      view.cleanup === 'cleanup-unresolved' ||
      view.cleanup === 'unknown-outcome';
    // A settled state is reported only with the acknowledgement behind it; one whose
    // acknowledgement was not recorded reads as still pending rather than inventing a reason.
    if (settled && acknowledgement !== undefined) {
      namespace['cleanup'] = {
        state: view.cleanup,
        acknowledgement: {
          status: acknowledgement.status,
          ...(acknowledgement.status === 'unresolved' ? { reason: acknowledgement.reason } : {}),
        },
      };
    } else {
      namespace['cleanup'] = { state: settled ? 'cleanup-pending' : view.cleanup };
    }
  }
  return Object.keys(namespace).length === 0 ? undefined : namespace;
}

/** What {@link projectTask} reads besides the task's view. */
export type ProjectionInput = {
  readonly view: TaskView;
  readonly record: A2ATaskRecord | undefined;
  /** The agent's reply, for a completed task. */
  readonly reply: ReplyParts | undefined;
  /** The cleanup acknowledgement recorded for the task, when one was. */
  readonly acknowledgement: TaskCleanupAcknowledgement | undefined;
  /** The input forms the task's open waits ask for; none when it is not waiting on one. */
  readonly forms?: readonly WaitForm[] | undefined;
  /** The task's interactive surfaces (COR-837); only the `a2ui` ones are projected. */
  readonly surfaces?: readonly InteractiveSurface[] | undefined;
};

/** How much of a task a response carries. */
export type ProjectionShape = {
  /** Absent keeps every message, `0` or less keeps none. */
  readonly historyLength?: number | undefined;
  readonly includeArtifacts: boolean;
  /** The extensions this request activated. */
  readonly activated: ReadonlySet<string>;
  /**
   * The catalogs the requesting client declared in `a2uiClientCapabilities` (only a send carries
   * them); `undefined` is no declaration, which offers the basic catalog only.
   */
  readonly supportedCatalogIds?: readonly string[] | undefined;
};

/** A message of the task's A2A history, read back from its wire form. */
function historyMessage(wire: A2AWireMessage): Message {
  return Message.fromJSON(wire);
}

/**
 * The parts that carry a task's A2UI surfaces (COR-837). A request that activated A2UI's extension
 * gets one data part per surface holding the messages that rebuild it, typed as A2UI's media type;
 * any other request gets each surface's text summary, so a client that cannot render one is still
 * told what it shows. A surface torn down or of another kind has no part.
 */
export function surfaceParts(
  surfaces: readonly InteractiveSurface[] | undefined,
  activated: ReadonlySet<string>,
  supportedCatalogIds?: readonly string[] | undefined,
): Part[] {
  const shown = (surfaces ?? []).filter(
    (surface) => surface.kind === 'a2ui' && surface.representation !== null,
  );
  if (!activated.has(A2UI_EXTENSION_URI)) return shown.map((surface) => textPart(surface.summary));
  // Per surface: A2UI data only for a client that supports the surface's catalog, else its text.
  const offered = offeredCatalogIds(supportedCatalogIds);
  return shown.map((surface) =>
    surface.representation?.kind === 'a2ui' && offered.includes(surface.representation.catalogId)
      ? {
          content: { $case: 'data' as const, value: a2uiMessagesOf(surface) },
          // The revision is what a renderer echoes as `a2uiSurfaceRevision` on its action.
          metadata: {
            mimeType: A2UI_MEDIA_TYPE,
            surfaceId: surface.surfaceId,
            a2uiSurfaceRevision: surface.revision,
          },
          filename: '',
          mediaType: A2UI_MEDIA_TYPE,
        }
      : textPart(surface.summary),
  );
}

/** A Bureau task as an A2A `Task`, shaped for one response. */
export function projectTask(input: ProjectionInput, shape: ProjectionShape): Task {
  const { view, record } = input;
  // The same bounded parts a stream publishes, so a stream and a read agree.
  const reply = input.reply === undefined ? undefined : publishedReplyParts(input.reply);
  const task = { id: view.id, contextId: view.contextId };
  let statusMessage: Message | undefined;
  const artifacts: Artifact[] = [];
  if (view.status === 'completed' && reply !== undefined && reply.length > 0) {
    statusMessage = agentMessage(task, replyMessageId(view.id), reply);
    artifacts.push({
      artifactId: resultArtifactId(view.id),
      name: 'result',
      description: '',
      parts: [...reply],
      metadata: undefined,
      extensions: [],
    });
  } else if (view.status === 'failed') {
    statusMessage = agentMessage(
      task,
      `${view.id}:failure`,
      view.statusMessage ?? view.finishReason ?? 'The task failed.',
    );
  } else if (view.status === 'input-required') {
    statusMessage = waitingMessage(view, input.forms);
  }
  // The task's A2UI surfaces ride on its status message, whatever the state: a frozen surface of a
  // finished task is still readable. They are not part of the reply artifact.
  const shownSurfaces = surfaceParts(input.surfaces, shape.activated, shape.supportedCatalogIds);
  if (shownSurfaces.length > 0) {
    const revisions = (input.surfaces ?? []).map(
      (surface) => `${surface.surfaceId}@${surface.revision}`,
    );
    statusMessage =
      statusMessage === undefined
        ? agentMessage(task, `${view.id}:surfaces:${revisions.join(',')}`, shownSurfaces)
        : { ...statusMessage, parts: [...statusMessage.parts, ...shownSurfaces] };
  }
  const history = (record?.history ?? []).map(historyMessage);
  const shownHistory =
    shape.historyLength === undefined
      ? history
      : shape.historyLength <= 0
        ? []
        : history.slice(-shape.historyLength);
  const cleanup = shape.activated.has(CLEANUP_EXTENSION_URI)
    ? cleanupMetadataOf(view, input.acknowledgement)
    : undefined;
  return {
    id: view.id,
    contextId: view.contextId,
    status: { state: a2aStateOf(view.status), message: statusMessage, timestamp: view.updatedAt },
    artifacts: shape.includeArtifacts ? artifacts : [],
    history: shownHistory,
    metadata: cleanup === undefined ? undefined : { [CLEANUP_EXTENSION_URI]: cleanup },
  };
}
