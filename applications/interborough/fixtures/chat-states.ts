/**
 * The chats of the ChatStates board that the sample world does not hold (COR-2016, design rows 19b
 * to 19p, 20f and 20h): a chat the server stopped mid-reply with what arrived kept, a Release
 * helper chat whose agent a disabled plugin holds back and whose approval waits, a reply that
 * failed partway, a turn that ended on a tool call, and the chat a person started from Workflows
 * whose agent created the workflow (PageNewChat, "After the agent created it", rows 24k and 24m). Their records are what the Bureau stores
 * and answers for such a chat: the thread's AG-UI messages, each call's recorded start and end
 * under `toolTiming`, the `action_required` outcome an approval parks on, the failed task a reply
 * stopped partway leaves, and the context record that lists the chat. A capture answers the
 * Bureau's own operations with them (`tests/e2e/chat-states.spec.ts`), the way
 * `tool-call-turn.ts` does for the long turn.
 *
 * The sample world's billing chat is stopped before its reply starts, and the Bureau keeps no text
 * of a reply that never completed (it projects text from the step a run records once the model has
 * answered), so the partial reply of frame a is added to that chat's thread here, as a record that
 * kept it would answer.
 *
 * @module chat-states
 */

/** The moment the person asked in every chat below that is dated Nov 2: 10:41 AM Central time (UTC-6). */
const ASKED = Date.parse('2026-11-02T16:41:00.000Z');

/** When the Lookup order call of the refund chat began, a moment after the person asked. */
const LOOKED_UP = ASKED + 1000;

/** The partial reply of the billing chat's thread, ended mid-sentence by the restart (frame a). */
export const ENDED_PARTIAL_REPLY =
  "I'll start with the invoices table, then the payments table, and check that every query still";

/** The thread identifier of the refund chat whose reply failed partway (frame f). */
export const FAILED_PARTWAY_THREAD = 'sample-chat-refund-failed-partway';

/** The thread identifier of the refund chat whose turn ended on a tool call (frame j). */
export const ENDED_ON_TOOL_CALL_THREAD = 'sample-chat-refund-ended-on-tool-call';

/** The title both refund chats carry, which is the sample world's refund chat's. */
export const REFUND_TITLE = 'Please refund order 4471, it arrived damaged.';

/** The thread identifier of the chat started from Workflows whose agent created a workflow (rows 24k, 24m). */
export const WORKFLOW_CREATED_THREAD = 'sample-chat-workflow-created';

/** What the person asked, which is the chat's title: the start the page filled in, finished. */
export const WORKFLOW_CREATED_ASK =
  'Help me build a workflow that sends me a summary of open reviews every morning.';

/** What Workflow author said once the workflow existed. */
export const WORKFLOW_CREATED_REPLY =
  'I made a daily workflow that gathers open reviews and sends you the summary at 9:00 AM Central time. You can change the schedule or the steps from its page.';

/** The identifier and name of the workflow the agent created. */
export const CREATED_WORKFLOW = { id: 'morning-briefing', name: 'Morning briefing' } as const;

/** The thread identifier of the Release helper chat held back by the disabled Demo plugin (frame c). */
export const HELD_BY_PLUGIN_THREAD = 'sample-chat-release-notes-held';

/** The Release helper chat's title. */
export const HELD_BY_PLUGIN_TITLE = 'Draft notes for 2.4';

/** The agent the held chat is with: the Demo plugin's Release helper. */
export const HELD_BY_PLUGIN_AGENT = 'demo:release-helper';

/** The question the held chat's approval asks. */
export const HELD_BY_PLUGIN_QUESTION = 'Publish notes for 2.4?';

/** The words under the held approval, as the page writes them for Release helper and the Demo plugin. */
export const HELD_BY_PLUGIN_REASON =
  'Release helper is unavailable, so this can’t be answered now. It returns when the Demo plugin is enabled.';

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();
const stamp = (milliseconds: number) => ({ 'conversationalist:createdAt': iso(milliseconds) });

/** What the Bureau records of the model that wrote a reply. */
const REPLY_MODEL = { provider: 'anthropic', model: 'claude-sonnet-5-5' } as const;

/** One tool call and its answer, as a step of the agent's records them. */
type Call = {
  readonly id: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  /** What the tool answered: text, or the fields of a result the way the Bureau's own tools answer. */
  readonly answer: string | Record<string, unknown>;
  /** When the person decided the approval the call waited on, when it waited on one. */
  readonly decidedAt?: number;
  /** What the approval asked, in the words the Bureau recorded with the decision. */
  readonly asked?: string;
  readonly startedAt: number;
  readonly milliseconds: number;
};

/**
 * The messages of one step that made `call`: the agent's row with the call, and the row that holds
 * its answer. `reply` is the text the agent said before it called, when it said any.
 */
function stepOf(
  step: number,
  runId: string,
  call: Call,
  reply?: string,
): Record<string, unknown>[] {
  const callMessage = {
    id: `${runId}:step:${String(step)}`,
    role: 'assistant',
    ...(reply === undefined ? {} : { content: reply }),
    metadata: { ...stamp(call.startedAt), 'bureau:replyModel': REPLY_MODEL },
    toolCalls: [
      {
        id: call.id,
        type: 'function',
        function: { name: call.tool, arguments: JSON.stringify(call.arguments) },
        metadata: stamp(call.startedAt),
      },
    ],
  };
  const ended = call.startedAt + call.milliseconds;
  return [
    callMessage,
    {
      id: `${runId}:step:${String(step)}:result:${call.id}`,
      role: 'tool',
      toolCallId: call.id,
      content: typeof call.answer === 'string' ? call.answer : JSON.stringify(call.answer),
      metadata: {
        toolTiming: { startedAt: iso(call.startedAt), endedAt: iso(ended) },
        ...stamp(ended),
        ...(call.decidedAt === undefined
          ? {}
          : {
              approvalDecision: {
                decision: 'approve',
                decidedBy: 'anonymous:local',
                decidedAt: iso(call.decidedAt),
                ...(call.asked === undefined ? {} : { asked: call.asked }),
              },
            }),
        'conversationalist:toolResult': { outcome: 'success', content: call.answer },
      },
    },
  ];
}

/** The Lookup order call the refund chats made: order 4471, answered in 0.4 seconds. */
const LOOKUP_4471: Call = {
  id: 'states-lookup-4471',
  tool: 'lookup-order',
  arguments: { orderId: '4471' },
  answer: '$42.00, delivered Monday, flagged damaged',
  startedAt: LOOKED_UP,
  milliseconds: 400,
};

const userMessage = (id: string, content: string, at: number): Record<string, unknown> => ({
  id,
  role: 'user',
  content,
  metadata: stamp(at),
});

/** The billing chat's thread with the part of its reply that arrived, kept after the person's message (frame a). */
export function billingThreadWithPartialReply(
  stored: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return [
    ...stored,
    {
      id: 'run-billing:step:0',
      role: 'assistant',
      // A reply that never completed has no finish time and no model on record, so its row carries
      // neither a stamp nor the actions under one.
      content: ENDED_PARTIAL_REPLY,
    },
  ];
}

/** The thread of the refund chat whose reply failed partway: the call answered, then text that stops mid-sentence (frame f). */
export const FAILED_PARTWAY_REPLY =
  'Order 4471 is $42.00, delivered Monday, and flagged as damaged. I can refund the full amount to the';

/** Why the provider stopped the reply, as the failed task records it. */
export const FAILED_PARTWAY_CAUSE = 'The model provider dropped the connection.';

/** The thread of frame f. */
export function failedPartwayMessages(): Record<string, unknown>[] {
  return [
    userMessage('user-states-failed', REFUND_TITLE, ASKED),
    ...stepOf(0, 'run-states-failed', LOOKUP_4471),
    {
      id: 'run-states-failed:step:1',
      role: 'assistant',
      content: FAILED_PARTWAY_REPLY,
    },
  ];
}

/** The thread of frame j: the call is answered and the run ends with no reply. */
export function endedOnToolCallMessages(): Record<string, unknown>[] {
  return [
    userMessage('user-states-ended-on-tool', REFUND_TITLE, ASKED),
    ...stepOf(0, 'run-states-ended-on-tool', LOOKUP_4471),
  ];
}

/** The change list the held chat's tool call answered, and the notes it is about to publish. */
const LIST_CHANGES: Call = {
  id: 'states-list-changes',
  tool: 'list-changes',
  arguments: { version: '2.4' },
  answer: '12 changes since 2.3',
  startedAt: Date.parse('2026-11-02T16:34:01.000Z'),
  milliseconds: 800,
};

/** The moment Release helper asked to publish, 12 minutes before the sample clock's 10:46 AM. */
const HELD_ASKED = Date.parse('2026-11-02T16:34:05.000Z');

/** The thread of frame c: the call answered, and the approval to publish waiting. */
export function heldByPluginMessages(): Record<string, unknown>[] {
  const requirement = 'Tool "publish-notes" (changes tier) requires approval (mode: on-changes).';
  const publishId = 'states-publish-notes';
  return [
    userMessage('user-states-held', HELD_BY_PLUGIN_TITLE, Date.parse('2026-11-02T16:34:00.000Z')),
    ...stepOf(0, 'run-states-held', LIST_CHANGES),
    {
      id: 'run-states-held:step:1',
      role: 'assistant',
      metadata: { ...stamp(HELD_ASKED - 20), 'bureau:replyModel': REPLY_MODEL },
      toolCalls: [
        {
          id: publishId,
          type: 'function',
          function: {
            name: 'publish-notes',
            arguments: JSON.stringify({ version: '2.4', changes: 12 }),
          },
          metadata: stamp(HELD_ASKED - 20),
        },
      ],
    },
    {
      id: `run-states-held:step:1:result:${publishId}`,
      role: 'tool',
      toolCallId: publishId,
      content: requirement,
      metadata: {
        ...stamp(HELD_ASKED),
        'conversationalist:toolResult': {
          outcome: 'action_required',
          action: {
            type: 'approval',
            message: HELD_BY_PLUGIN_QUESTION,
            risk: 'medium',
            operation: { argsPreview: { version: '2.4', changes: 12 }, kind: 'other' },
            policyVersion: 'policy:1',
            idempotencyKey: 'approval:release-notes-2.4',
          },
          content: requirement,
        },
      },
    },
  ];
}

/** The Create workflow call of the chat started from Workflows: approved at 10:42 AM, answered in 0.8 seconds. */
const CREATE_MORNING_BRIEFING: Call = {
  id: 'states-create-morning-briefing',
  tool: 'bureau__workflows-create',
  arguments: {
    name: CREATED_WORKFLOW.name,
    trigger: { kind: 'schedule', spec: 'Every day at 9:00 AM Central time' },
    steps: [{ kind: 'activity', handler: 'agent', input: { agent: 'assistant' } }],
  },
  answer: { status: 'ok', id: CREATED_WORKFLOW.id, hash: 'sha256:5b0c' },
  startedAt: Date.parse('2026-11-02T16:42:10.000Z'),
  milliseconds: 800,
  decidedAt: Date.parse('2026-11-02T16:42:09.000Z'),
  asked: `Create workflow “${CREATED_WORKFLOW.name}”?`,
};

/** The thread of the chat started from Workflows: the ask, the call that created the workflow, and the reply. */
export function workflowCreatedMessages(): Record<string, unknown>[] {
  return [
    userMessage('user-states-workflow-created', WORKFLOW_CREATED_ASK, ASKED),
    ...stepOf(0, 'run-states-workflow-created', CREATE_MORNING_BRIEFING),
    {
      id: 'run-states-workflow-created:step:1',
      role: 'assistant',
      content: WORKFLOW_CREATED_REPLY,
      metadata: {
        ...stamp(CREATE_MORNING_BRIEFING.startedAt + 1500),
        'bureau:replyModel': REPLY_MODEL,
      },
    },
  ];
}

/** Which of the board's chats a record is for. */
export type StatesChat =
  'failed-partway' | 'ended-on-tool-call' | 'held-by-plugin' | 'workflow-created';

/** The thread identifier of `chat`. */
export function threadOf(chat: StatesChat): string {
  switch (chat) {
    case 'failed-partway':
      return FAILED_PARTWAY_THREAD;
    case 'ended-on-tool-call':
      return ENDED_ON_TOOL_CALL_THREAD;
    case 'held-by-plugin':
      return HELD_BY_PLUGIN_THREAD;
    case 'workflow-created':
      return WORKFLOW_CREATED_THREAD;
  }
}

/** The messages of `chat`'s thread. */
export function messagesOf(chat: StatesChat): Record<string, unknown>[] {
  switch (chat) {
    case 'failed-partway':
      return failedPartwayMessages();
    case 'ended-on-tool-call':
      return endedOnToolCallMessages();
    case 'held-by-plugin':
      return heldByPluginMessages();
    case 'workflow-created':
      return workflowCreatedMessages();
  }
}

/** What the chat list reads under a chat's title: its last message, or the question it waits on. */
function previewOf(chat: StatesChat): string {
  switch (chat) {
    case 'held-by-plugin':
      return HELD_BY_PLUGIN_QUESTION;
    case 'failed-partway':
      return FAILED_PARTWAY_REPLY;
    case 'ended-on-tool-call':
      return REFUND_TITLE;
    case 'workflow-created':
      return WORKFLOW_CREATED_REPLY;
  }
}

/**
 * How full the window of each of these chats is, as `bureau.contexts.window` answers for a model
 * whose window is 200,000 tokens: 76,000 estimated, which the composer's ring reads as 38%.
 */
export const STATES_CONTEXT_WINDOW = {
  maxTokens: 200_000,
  usedEstimated: 76_000,
  usedReported: null,
  categories: [
    { name: 'system', tokens: 4000 },
    { name: 'tools', tokens: 14_000 },
    { name: 'messages', tokens: 52_000 },
    { name: 'memory', tokens: 6000 },
    { name: 'attachments', tokens: 0 },
  ],
} as const;

/**
 * The chat's context record, `bureau.contexts.get` and each entry of `bureau.contexts.list`. `kind`
 * is another Tool runner chat's record, so the agent's settings and configuration are the ones the
 * Bureau holds. A chat waiting on the held approval is `awaiting-input`; the others are idle.
 */
export function contextOf(
  chat: StatesChat,
  kind: Record<string, unknown>,
): Record<string, unknown> {
  const messages = messagesOf(chat);
  const held = chat === 'held-by-plugin';
  const created = chat === 'workflow-created';
  const startedAt = held ? Date.parse('2026-11-02T16:34:00.000Z') : ASKED;
  return {
    ...kind,
    id: threadOf(chat),
    title: held ? HELD_BY_PLUGIN_TITLE : created ? WORKFLOW_CREATED_ASK : REFUND_TITLE,
    ...(held ? { agentName: HELD_BY_PLUGIN_AGENT } : {}),
    ...(created ? { agentName: 'workflow-author' } : {}),
    lastMessagePreview: previewOf(chat),
    messageCount: messages.length,
    createdAt: iso(startedAt),
    updatedAt: iso(startedAt + 5000),
    activity: held ? 'awaiting-input' : 'idle',
    endReason: null,
    archivedAt: null,
  };
}

/**
 * The tasks `bureau.tasks.list` answers for `chat`: the run of a reply that failed partway is a
 * failed task whose message says why; a turn that ended on a tool call is a task that completed;
 * the held chat's run waits on the approval.
 */
export function tasksOf(chat: StatesChat): Record<string, unknown>[] {
  const common = {
    contextId: threadOf(chat),
    owner: 'anonymous:local',
    actor: null,
    kind: 'chat',
    cleanup: null,
    openWaits: [],
    wakeAt: null,
  };
  switch (chat) {
    case 'failed-partway':
      return [
        {
          ...common,
          id: 'run-states-failed',
          agentName: 'tool-runner',
          origin: { kind: 'chat', contextId: FAILED_PARTWAY_THREAD, principal: 'anonymous:local' },
          status: 'failed',
          finishReason: 'error',
          statusMessage: FAILED_PARTWAY_CAUSE,
          createdAt: iso(ASKED),
          updatedAt: iso(LOOKED_UP + 2000),
        },
      ];
    case 'ended-on-tool-call':
      return [
        {
          ...common,
          id: 'run-states-ended-on-tool',
          agentName: 'tool-runner',
          origin: {
            kind: 'chat',
            contextId: ENDED_ON_TOOL_CALL_THREAD,
            principal: 'anonymous:local',
          },
          status: 'completed',
          finishReason: 'stop',
          statusMessage: null,
          createdAt: iso(ASKED),
          updatedAt: iso(LOOKED_UP + 1400),
        },
      ];
    case 'workflow-created':
      return [
        {
          ...common,
          id: 'run-states-workflow-created',
          agentName: 'workflow-author',
          origin: {
            kind: 'chat',
            contextId: WORKFLOW_CREATED_THREAD,
            principal: 'anonymous:local',
          },
          status: 'completed',
          finishReason: 'stop',
          statusMessage: null,
          createdAt: iso(ASKED),
          updatedAt: iso(CREATE_MORNING_BRIEFING.startedAt + 2000),
        },
      ];
    case 'held-by-plugin':
      return [];
  }
}
