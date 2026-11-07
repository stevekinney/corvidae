/**
 * The long turn of the ToolCallOptions board (COR-2016, design rows 21o, 21p and 21q): one chat in
 * which Tool runner checks the Parcelly damaged-carrier batch against the refund policy, calls
 * thirty tools, has one fail (Send email, an SMTP timeout), has one approved after the fact (Issue
 * refund for order 4476) and ends waiting on the person to approve the last (Issue refund for order
 * 4480). The turn is outside the sample world, whose Tool runner chats make two calls, so a capture
 * answers the Bureau's own operations with this chat's records (`tests/e2e/chat-tool-call-turn.spec.ts`).
 *
 * Everything here is what the Bureau stores and answers for such a chat: the thread's AG-UI
 * messages, each call's recorded start and end under `toolTiming`, the approval decision the person
 * left on the approved call, the `action_required` outcome the waiting call parks on, and the
 * context record that lists the chat. The figures are the board's: each call's key input, answer and
 * duration, the 9:52 AM the chat lists under, the 9:58 AM the approved refund ran at, and the 18
 * seconds the turn spent on its tools. Calls the agent made together (a batch of lookups) overlap
 * in time, which is why the 28 calls that ran before the approval add up to 20.0 seconds of calls
 * and take 17.1 of them; the approved refund ran for 0.9 seconds six minutes later.
 *
 * @module tool-call-turn
 */

/** The chat's thread identifier. */
export const TOOL_CALL_TURN_THREAD = 'sample-chat-parcelly-batch';

/** The chat's title, which its heading, its list row and the breadcrumb read. */
export const TOOL_CALL_TURN_TITLE =
  'Check the Parcelly damaged-carrier batch against the refund policy.';

/** What the person asked, at 9:52 AM Central time. */
export const TOOL_CALL_TURN_MESSAGE =
  'Check the Parcelly damaged-carrier batch against the refund policy, then refund what qualifies.';

/** How many calls the turn makes, and how many of them the rail folds behind "Show 24 more". */
export const TOOL_CALL_TURN_CALLS = 30;

/** The turn's time on its tools, which the summary line ends with. */
export const TOOL_CALL_TURN_SECONDS = 18;

/** The question the last call waits on, which the list row also reads. */
export const TOOL_CALL_TURN_QUESTION = 'Refund order 4480 for $27.25?';

/** The moment the person asked, 9:52 AM Central time on Monday, Nov 2 (Central standard time is UTC-6). */
const ASKED = Date.parse('2026-11-02T15:52:00.000Z');

/** When the approved refund ran, after the person approved it at 9:58 AM. */
const APPROVED = Date.parse('2026-11-02T15:58:00.000Z');

/** When the last call asked for its approval, two minutes before the sample clock's 10:46 AM. */
const ASKED_APPROVAL = Date.parse('2026-11-02T16:44:00.000Z');

/** The pause between a step finishing and the agent's next one, which no call is under way in. */
const THINKING_MILLISECONDS = 200;

/** One call of the turn, as the agent made it. */
type Call = {
  readonly tool: string;
  readonly arguments: Record<string, string>;
  /** What the tool answered, as text. */
  readonly answer: string;
  readonly seconds: number;
  /** How long after the step began the call began, for a call that did not start with its step. */
  readonly delaySeconds?: number;
  readonly failure?: string;
};

const lookup = (orderId: string, answer: string, seconds: number, delaySeconds?: number): Call => ({
  tool: 'lookup-order',
  arguments: { orderId },
  answer,
  seconds,
  ...(delaySeconds === undefined ? {} : { delaySeconds }),
});

const inventory = (sku: string, answer: string, seconds: number): Call => ({
  tool: 'check-inventory',
  arguments: { sku },
  answer,
  seconds,
});

const customer = (id: string, answer: string, seconds: number): Call => ({
  tool: 'lookup-customer',
  arguments: { customerId: id },
  answer,
  seconds,
});

const search = (query: string, answer: string, seconds: number): Call => ({
  tool: 'search-orders',
  arguments: { query },
  answer,
  seconds,
});

const draft = (note: string, seconds: number): Call => ({
  tool: 'draft-email',
  arguments: { note },
  answer: 'Draft saved',
  seconds,
});

/**
 * The steps of the turn that ran before the approvals: each step is the calls the agent made
 * together, and a step begins when the one before it has finished and the agent has answered.
 * Twenty-eight calls in all.
 */
const STEPS: readonly (readonly Call[])[] = [
  [search('carrier Parcelly, damaged', '14 orders', 0.6)],
  [
    lookup('4471', '$42.00, delivered Mon', 0.2),
    lookup('4476', '$96.00, delivered Mon', 0.3),
    lookup('4476', '$96.00, delivered Tue', 0.4),
    lookup('4480', '$27.25, delivered Tue', 0.5),
  ],
  [
    lookup('4483', '$61.10, delivered Tue', 0.2),
    lookup('4487', '$15.00, delivered Wed', 0.3),
    lookup('4490', '$38.75, delivered Wed', 0.4),
    lookup('4492', '$72.40, delivered Wed', 0.5),
  ],
  [
    lookup('4495', '$22.00, delivered Thu', 0.2),
    lookup('4501', '$54.90, delivered Thu', 0.3),
    lookup('4503', '$31.60, delivered Thu', 0.4),
    lookup('4508', '$19.99, delivered Fri', 0.5, 0.1),
  ],
  [
    {
      tool: 'read-policy',
      arguments: { policy: 'refund-policy' },
      answer: 'Damaged items refundable within 30 days',
      seconds: 0.2,
    },
  ],
  [inventory('MUG-04', '6 in stock', 0.3)],
  [inventory('LMP-11', '0 in stock', 0.3)],
  [inventory('PLT-02', '14 in stock', 0.2)],
  [inventory('MUG-09', '3 in stock', 0.3)],
  [
    customer('cus_8821', 'Maya Ortiz, 3 orders', 0.4),
    customer('cus_9034', 'Dev Patel, 1 order', 0.3),
  ],
  [customer('cus_7710', 'Ana Silva, 5 orders', 0.4)],
  [customer('cus_9102', 'Lee Chen, 2 orders', 0.3)],
  [search('prior refunds, 30 days', '2 found', 0.5)],
  [search('duplicate shipments', 'none', 0.5)],
  [draft('refund notice, 4471', 0.6)],
  [draft('refund notice, 4472', 0.6)],
  [
    {
      tool: 'update-ticket',
      arguments: { ticket: 'T-2291' },
      answer: 'Marked pending refund',
      seconds: 0.3,
    },
  ],
  [
    {
      tool: 'send-email',
      arguments: { to: 'maya@example.com', template: 'refund-notice', orderId: '4471' },
      answer: '',
      seconds: 10,
      failure: 'SMTP timeout after 10s',
    },
  ],
];

/** The refund the person approved, which ran after they did. */
const APPROVED_REFUND = {
  orderId: '4476',
  amount: '$96.00',
  reason: 'Arrived damaged',
} as const;

/** The refund the turn waits on. */
const WAITING_REFUND = {
  orderId: '4480',
  amount: '$27.25',
  reason: 'Arrived damaged',
} as const;

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();
const stamp = (milliseconds: number) => ({ 'conversationalist:createdAt': iso(milliseconds) });

/** The agent's reply that opens the turn, which the rail follows. */
const OPENING_REPLY = 'Checking the Parcelly damaged-carrier batch against the refund policy.';

/** What the Bureau records of the model that wrote a reply. */
const REPLY_MODEL = { provider: 'anthropic', model: 'claude-sonnet-5-5' } as const;

type ToolCallRecord = {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
  readonly metadata: Record<string, unknown>;
};

/**
 * The thread's AG-UI messages (`GET /bureau/ag-ui/threads/<id>/messages`): the person's message, a
 * step of the agent's for each batch of calls with the answer to each call after it, then the step
 * that asks to refund order 4476, whose answer is the person's approval, and the one that asks to
 * refund order 4480 and waits.
 */
export function toolCallTurnMessages(): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [
    {
      id: 'user-parcelly-1',
      role: 'user',
      content: TOOL_CALL_TURN_MESSAGE,
      metadata: stamp(ASKED),
    },
  ];
  let clock = ASKED + 2000;
  let number = 0;
  let step = 0;
  const pushStep = (
    calls: readonly {
      readonly call: ToolCallRecord;
      readonly result: Record<string, unknown>;
    }[],
    startedAt: number,
  ): void => {
    messages.push({
      id: `run-parcelly:step:${String(step)}`,
      role: 'assistant',
      ...(step === 0 ? { content: OPENING_REPLY } : {}),
      metadata: { ...stamp(startedAt), 'bureau:replyModel': REPLY_MODEL },
      toolCalls: calls.map(({ call }) => call),
    });
    for (const { call, result } of calls) {
      messages.push({
        id: `run-parcelly:step:${String(step)}:result:${call.id}`,
        role: 'tool',
        toolCallId: call.id,
        ...result,
      });
    }
    step += 1;
  };
  for (const calls of STEPS) {
    const startedAt = clock;
    let finished = startedAt;
    pushStep(
      calls.map((entry) => {
        number += 1;
        const callId = `parcelly-call-${String(number)}`;
        const began = startedAt + Math.round((entry.delaySeconds ?? 0) * 1000);
        const ended = began + Math.round(entry.seconds * 1000);
        finished = Math.max(finished, ended);
        const timing = { startedAt: iso(began), endedAt: iso(ended) };
        return {
          call: {
            id: callId,
            type: 'function' as const,
            function: { name: entry.tool, arguments: JSON.stringify(entry.arguments) },
            metadata: stamp(began),
          },
          result:
            entry.failure === undefined
              ? {
                  content: entry.answer,
                  metadata: {
                    toolTiming: timing,
                    ...stamp(ended),
                    'conversationalist:toolResult': { outcome: 'success', content: entry.answer },
                  },
                }
              : {
                  content: entry.failure,
                  error: entry.failure,
                  metadata: {
                    toolTiming: timing,
                    ...stamp(ended),
                    'conversationalist:toolResult': {
                      outcome: 'error',
                      content: entry.failure,
                      error: {
                        message: entry.failure,
                        code: 'smtp-timeout',
                        category: 'timeout',
                        retryable: true,
                      },
                    },
                  },
                },
        };
      }),
      startedAt,
    );
    clock = finished + THINKING_MILLISECONDS;
  }

  number += 1;
  const approvedId = `parcelly-call-${String(number)}`;
  pushStep(
    [
      {
        call: {
          id: approvedId,
          type: 'function',
          function: { name: 'issue-refund', arguments: JSON.stringify(APPROVED_REFUND) },
          metadata: stamp(clock),
        },
        result: {
          content: 'Refunded $96.00',
          metadata: {
            toolTiming: { startedAt: iso(APPROVED + 100), endedAt: iso(APPROVED + 1000) },
            approvalDecision: {
              decision: 'approve',
              decidedBy: 'anonymous:local',
              decidedAt: iso(APPROVED),
              asked: 'Refund order 4476 for $96.00?',
            },
            ...stamp(APPROVED + 1000),
            'conversationalist:toolResult': { outcome: 'success', content: 'Refunded $96.00' },
          },
        },
      },
    ],
    clock,
  );

  number += 1;
  const waitingId = `parcelly-call-${String(number)}`;
  const requirement = 'Tool "issue-refund" (dangerous tier) requires approval (mode: always).';
  pushStep(
    [
      {
        call: {
          id: waitingId,
          type: 'function',
          function: { name: 'issue-refund', arguments: JSON.stringify(WAITING_REFUND) },
          metadata: stamp(ASKED_APPROVAL - 20),
        },
        result: {
          content: requirement,
          metadata: {
            ...stamp(ASKED_APPROVAL),
            'conversationalist:toolResult': {
              outcome: 'action_required',
              action: {
                type: 'approval',
                message: TOOL_CALL_TURN_QUESTION,
                risk: 'high',
                operation: {
                  argsPreview: { ...WAITING_REFUND, cents: 2725 },
                  kind: 'other',
                },
                policyVersion: 'policy:1',
                idempotencyKey: 'approval:parcelly-4480',
              },
              content: requirement,
            },
          },
        },
      },
    ],
    ASKED_APPROVAL - 20,
  );
  return messages;
}

/**
 * The chat's context record, `bureau.contexts.get` and each entry of `bureau.contexts.list`: a
 * chat with Tool runner that waits on the person, listed under 9:52 AM (the time the person asked).
 * `kind` is another Tool runner chat's record, so the agent, its settings and its configuration are
 * the ones the Bureau holds for that agent.
 */
export function toolCallTurnContext(kind: Record<string, unknown>): Record<string, unknown> {
  return {
    ...kind,
    id: TOOL_CALL_TURN_THREAD,
    title: TOOL_CALL_TURN_TITLE,
    lastMessagePreview: TOOL_CALL_TURN_QUESTION,
    messageCount: toolCallTurnMessages().length,
    createdAt: iso(ASKED),
    updatedAt: iso(ASKED + 21_000),
    activity: 'awaiting-input',
    endReason: null,
  };
}
