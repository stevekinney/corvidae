/**
 * The scenario builders behind the Chat stress cases (COR-2289). Each one turns a case's `params`
 * into the conversation and the plain-data props the fixture hands to the real `Chat`; the fixture
 * (`../chat-stress.svelte`) adds the callbacks. A scenario seeds only what a person would find on
 * the page before acting: an approval waiting, a run in progress, a question open. What the person
 * does next (typing, pressing Send now instead, choosing an option, answering) is a step of the
 * case that the capture tool drives through the real controls, never a seeded end state.
 */
import {
  appendAssistantMessage,
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversation,
  type ChatApprovalDetails,
  type ChatCapabilities,
  type ChatTurnState,
  type ConversationHistory,
  type Message,
  type ReasoningInfo,
} from '@lostgradient/chat';
import type { CitationSource } from '@lostgradient/cinder';

import type { StressCase } from './stress-cases.ts';

/** The sample world's "now": every case runs with the browser's clock fixed here. */
export const STRESS_NOW = '2026-11-02T16:46:00.000Z';

const BASE_TIME = Date.parse('2026-11-02T15:00:00.000Z');

/** What the fixture shows in place of the transcript or the composer, as plain data. */
export type StressAvailability =
  | { kind: 'loading'; slowAfterSeconds?: number }
  | { kind: 'error'; cause: string; detail?: string }
  | { kind: 'deleted' };

/** The composer status a case seeds, as plain data; the fixture adds the callbacks. */
export type StressStatus =
  | { kind: 'blocked'; reason: string; action: string; link?: string }
  | { kind: 'archived'; when: string }
  | { kind: 'read-only'; tooltip: string }
  | { kind: 'draft-restored'; when: string }
  | { kind: 'offline' };

/** Which upload behavior the composer's `uploadAttachment` hook has. */
export type StressUploads = 'none' | 'mixed' | 'ready';

/** Everything a scenario decides; the fixture reads it and wires the callbacks. */
export interface StressSetup {
  conversation: ConversationHistory;
  streaming: boolean;
  /** Whether the adapter takes follow-ups during a run (`sendRunInput` and `removeRunInput`). */
  runInput: boolean;
  status?: StressStatus;
  availability?: StressAvailability;
  /** Turn states by the assistant turn's position among the assistant turns, from zero. */
  turnStates: Record<number, ChatTurnState>;
  questionPlacement: 'inline' | 'docked';
  variant: 'bubble' | 'transcript';
  capabilities: ChatCapabilities;
  uploads: StressUploads;
  approvalDetails: Record<string, ChatApprovalDetails>;
  reasoning: Record<number, ReasoningInfo>;
  /** Sources by the assistant turn's position, from zero. */
  sources: Record<number, CitationSource[]>;
  sourcePresentation?: 'compact' | 'list' | 'inline';
  /** Shows Regenerate, Copy and Quote under replies. */
  regenerate: boolean;
  /** A draft the host puts back in the composer when the page loads. */
  restoredDraft?: string;
  /** The inline size of the chat shell in CSS pixels, when the case is about a narrow composer. */
  shellWidth?: number;
  /** Mounts a second chat under the first, each with its own composer. */
  secondChat: boolean;
  emptyPrompts: string[];
  direction?: 'rtl';
  /** The sample sources a host can withdraw while a citation is open. */
  withdrawable: boolean;
}

/** The empty setup every scenario starts from. */
function baseSetup(conversation: ConversationHistory): StressSetup {
  return {
    conversation,
    streaming: false,
    runInput: false,
    turnStates: {},
    questionPlacement: 'inline',
    variant: 'transcript',
    capabilities: { attachments: false },
    uploads: 'none',
    approvalDetails: {},
    reasoning: {},
    sources: {},
    regenerate: true,
    secondChat: false,
    emptyPrompts: [],
    withdrawable: false,
  };
}

/** Gives every message a stable id and a fixed time, so two runs of a case draw the same page. */
export function stabilize(history: ConversationHistory): ConversationHistory {
  const ids = history.ids.map((_, index) => `stress-m${index + 1}`);
  const messages: Record<string, Message> = {};
  history.ids.forEach((id, index) => {
    const message = history.messages[id];
    const stableId = ids[index];
    if (message === undefined || stableId === undefined) return;
    messages[stableId] = {
      ...message,
      id: stableId,
      createdAt: new Date(BASE_TIME + index * 60_000).toISOString(),
    };
  });
  const created = new Date(BASE_TIME).toISOString();
  return { ...history, ids, messages, createdAt: created, updatedAt: created };
}

function start(id: string): ConversationHistory {
  return createConversation({ id });
}

function withCall(
  history: ConversationHistory,
  id: string,
  name: string,
  args: Record<string, string | number | boolean>,
  result?: Record<string, string | number | boolean>,
): ConversationHistory {
  const called = appendToolCall(history, { id, name, arguments: args });
  if (result === undefined) return called;
  return appendToolResult(called, { callId: id, outcome: 'success', content: result });
}

function withFailedCall(
  history: ConversationHistory,
  id: string,
  name: string,
  args: Record<string, string | number | boolean>,
  message: string,
): ConversationHistory {
  return appendToolResult(appendToolCall(history, { id, name, arguments: args }), {
    callId: id,
    outcome: 'error',
    content: null,
    error: { code: 'upstream', category: 'internal', retryable: true, message },
  });
}

/** An approval waiting on the person, with the shape the Chat harness fixture uses. */
function withApproval(
  history: ConversationHistory,
  id: string,
  name: string,
  command: string,
  options: { message?: string; expiresAt?: string; risk?: 'low' | 'medium' | 'high' } = {},
): ConversationHistory {
  return appendToolResult(appendToolCall(history, { id, name, arguments: { command } }), {
    callId: id,
    outcome: 'action_required',
    content: null,
    action: {
      type: 'approval',
      message: options.message ?? 'Approve running this tool before it executes?',
      risk: options.risk ?? 'high',
      operation: { kind: 'command', command, argsPreview: { command } },
      sandbox: { provider: 'Corvidae', name: 'stress', workingDir: '/workspace/corvidae' },
      snapshotId: `snapshot-${id}`,
      expiresAt: options.expiresAt ?? '2999-01-01T00:00:00.000Z',
      policyVersion: 'stress-policy-v1',
      idempotencyKey: `stress-${id}`,
    },
  });
}

/** A question the agent asks, as the `requestHumanInput` tool result Chat draws. */
function withQuestion(
  history: ConversationHistory,
  id: string,
  message: string,
  schema: Record<string, unknown>,
): ConversationHistory {
  return appendToolResult(
    appendToolCall(history, { id, name: 'requestHumanInput', arguments: {} }),
    {
      callId: id,
      outcome: 'action_required',
      content: null,
      action: { type: 'input', message, schema },
    },
  );
}

const ENVIRONMENT_SCHEMA = {
  enum: ['staging', 'production', 'canary'],
  'x-labels': { staging: 'Staging', production: 'Production', canary: 'Canary' },
  'x-descriptions': {
    staging: 'Safe to break',
    production: 'Customers see it',
    canary: 'A tenth of customers',
  },
};

const ENVIRONMENT_OR_OTHER_SCHEMA = {
  anyOf: [{ enum: ['staging', 'production', 'canary'] }, { type: 'string', maxLength: 80 }],
  'x-allowOther': true,
  'x-labels': { staging: 'Staging', production: 'Production', canary: 'Canary' },
  'x-descriptions': {
    staging: 'Safe to break',
    production: 'Customers see it',
    canary: 'A tenth of customers',
  },
};

const LONG_TOOL = 'orders_reconciliation_ledger_export_with_a_very_long_generated_identifier_v2';

const SAMPLE_SOURCES: CitationSource[] = [
  {
    label: 'Q3 refund policy',
    url: 'https://docs.example.com/refunds',
    detail: 'Refunds over $40 need review.',
  },
  { label: 'Order 4471 audit log', url: 'https://audit.example.org/orders/4471' },
  { label: 'Support playbook', detail: 'Internal document with no public address.' },
];

/** A shared transcript: one question and one answer. */
function plainTurn(id: string, question: string, answer: string): ConversationHistory {
  return appendAssistantMessage(appendUserMessage(start(id), question), answer);
}

type Scenario = (stressCase: StressCase) => StressSetup;

function param<Value>(stressCase: StressCase, key: string, fallback: Value): Value {
  const value = stressCase.params[key];
  return value === undefined ? fallback : (value as Value);
}

const scenarios: Record<string, Scenario> = {
  'empty-first-use': () => {
    const setup = baseSetup(start('stress-empty'));
    setup.emptyPrompts = ['Summarize this week', 'Draft a release note', 'Find stale branches'];
    return setup;
  },

  availability: (stressCase) => {
    const kind = param<'loading' | 'error' | 'deleted'>(stressCase, 'kind', 'loading');
    const setup = baseSetup(
      plainTurn('stress-availability', 'Where did the refund go?', 'It was issued on Nov 1.'),
    );
    if (kind === 'loading') {
      setup.availability = {
        kind: 'loading',
        slowAfterSeconds: param(stressCase, 'slowAfterSeconds', 10),
      };
    } else if (kind === 'error') {
      setup.availability = {
        kind: 'error',
        cause: 'The history service did not answer. Nothing was lost.',
        detail: 'fault ECONNRESET at history.read',
      };
    } else setup.availability = { kind: 'deleted' };
    return setup;
  },

  'composer-status': (stressCase) => {
    const kind = param<'blocked' | 'archived' | 'read-only'>(stressCase, 'kind', 'blocked');
    const setup = baseSetup(
      plainTurn('stress-status', 'Can you recap the incident?', 'The incident ended at 09:12.'),
    );
    if (kind === 'blocked') {
      setup.status = {
        kind: 'blocked',
        reason: 'Connect a model provider to chat',
        action: 'Connect provider',
        link: 'Use Assistant',
      };
    } else if (kind === 'archived') setup.status = { kind: 'archived', when: 'Nov 3' };
    else {
      setup.status = {
        kind: 'read-only',
        tooltip: 'Dana Reyes removed your write access on Nov 3',
      };
    }
    return setup;
  },

  idle: (stressCase) => {
    const setup = baseSetup(
      plainTurn(
        'stress-idle',
        'Summarize the rollout plan.',
        'The rollout has three phases: canary, staged and general availability.',
      ),
    );
    const status = param<string | undefined>(stressCase, 'status', undefined);
    if (status === 'draft-restored') {
      setup.status = { kind: 'draft-restored', when: 'yesterday at 4:12 PM' };
      setup.restoredDraft = 'Add the rollback owner to the plan';
    }
    return setup;
  },

  run: (stressCase) => {
    let conversation = appendUserMessage(start('stress-run'), 'Reconcile the October ledger.');
    conversation = appendAssistantMessage(conversation, 'Reading the ledger entries now');
    const setup = baseSetup(conversation);
    setup.streaming = true;
    setup.runInput = true;
    setup.turnStates[0] = { kind: 'streaming' };
    if (param(stressCase, 'narrow', false)) setup.shellWidth = 360;
    return setup;
  },

  'stream-code': () => {
    const conversation = appendUserMessage(
      start('stress-stream'),
      'Show the query that finds stale orders.',
    );
    const setup = baseSetup(conversation);
    setup.runInput = true;
    return setup;
  },

  'code-blocks': (stressCase) => {
    const wide = param(stressCase, 'wide', false);
    const line = wide
      ? `SELECT order_identifier, customer_identifier, refund_amount_in_minor_units, refund_reason_code, reviewed_by_agent FROM refunds_pending_review WHERE refund_amount_in_minor_units > 4000 ORDER BY created_at DESC;`
      : 'SELECT id, total FROM orders WHERE total > 4000;';
    const setup = baseSetup(
      plainTurn(
        'stress-code',
        'Which query lists large orders?',
        `Run this query:\n\n\`\`\`sql\n${line}\n\`\`\`\n\nIt returns the large orders first.`,
      ),
    );
    return setup;
  },

  'wide-table': () =>
    baseSetup(
      plainTurn(
        'stress-table',
        'Compare the three plans.',
        '| Plan | Seats | Storage | Support | Audit log | SSO | Region | Price |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| Team | 10 | 100 GB | Email | 30 days | No | us-east | $40 |\n| Business | 100 | 1 TB | Chat | 1 year | Yes | eu-west | $400 |\n| Enterprise | 1000 | 10 TB | Phone | 7 years | Yes | any | $4,000 |',
      ),
    ),

  'date-and-actions': () => {
    const setup = baseSetup(
      plainTurn(
        'stress-actions',
        'Draft the status update.',
        'Shipped the canary and started the staged rollout.',
      ),
    );
    return setup;
  },

  'tool-group': (stressCase) => {
    const shape = param<'repeat' | 'steps' | 'approval' | 'identifier' | 'failed'>(
      stressCase,
      'shape',
      'steps',
    );
    let conversation = appendUserMessage(start('stress-tools'), 'Check the refund queue.');
    const setup = baseSetup(conversation);
    if (shape === 'repeat') {
      for (let index = 1; index <= 20; index += 1) {
        conversation = withCall(
          conversation,
          `lookup-${index}`,
          'lookup_order',
          { orderId: `${4400 + index}` },
          { status: 'found' },
        );
      }
      conversation = appendAssistantMessage(
        conversation,
        'Compared 20 recent orders. All of them match the ledger.',
      );
    } else if (shape === 'steps') {
      conversation = withCall(
        conversation,
        'read-policy',
        'read_policy',
        { document: 'refunds' },
        { status: 'ok' },
      );
      conversation = withCall(
        conversation,
        'read-orders',
        'list_orders',
        { limit: 20 },
        { status: 'ok' },
      );
      conversation = withCall(
        conversation,
        'read-log',
        'read_audit_log',
        { orderId: '4471' },
        { status: 'ok' },
      );
      conversation = appendAssistantMessage(
        conversation,
        'The policy and the audit log agree on the 4471 refund.',
      );
    } else if (shape === 'approval') {
      conversation = withCall(
        conversation,
        'read-policy',
        'read_policy',
        { document: 'refunds' },
        { status: 'ok' },
      );
      conversation = withCall(
        conversation,
        'read-orders',
        'list_orders',
        { limit: 20 },
        { status: 'ok' },
      );
      conversation = withApproval(
        conversation,
        'refund-4471',
        'issue_refund',
        'refund order 4471 --amount 4200',
      );
    } else if (shape === 'identifier') {
      conversation = withCall(
        conversation,
        'read-policy',
        'read_policy',
        { document: 'refunds' },
        { status: 'ok' },
      );
      conversation = withApproval(
        conversation,
        'export-ledger',
        LONG_TOOL,
        `${LONG_TOOL} --since 2026-10-01`,
      );
    } else {
      conversation = withCall(
        conversation,
        'source-1',
        'fetch_source',
        { source: 'ledger' },
        { status: 'ok' },
      );
      conversation = withCall(
        conversation,
        'source-2',
        'fetch_source',
        { source: 'orders' },
        { status: 'ok' },
      );
      conversation = withFailedCall(
        conversation,
        'source-3',
        'fetch_source',
        { source: 'audit' },
        'The audit service returned 503 after three tries, so the source could not be read.',
      );
      conversation = appendAssistantMessage(conversation, 'Two of three sources were readable.');
    }
    setup.conversation = conversation;
    if (shape === 'approval') {
      setup.approvalDetails['issue_refund'] = { irreversible: true, approveLabel: 'Refund $42.00' };
    }
    return setup;
  },

  approval: (stressCase) => {
    const shape = param<'reversible' | 'irreversible' | 'expired' | 'two' | 'command' | 'rtl'>(
      stressCase,
      'shape',
      'reversible',
    );
    let conversation = appendUserMessage(start('stress-approval'), 'Refund order 4471.');
    const setup = baseSetup(conversation);
    if (shape === 'expired') {
      conversation = withApproval(
        conversation,
        'refund-4471',
        'issue_refund',
        'refund order 4471 --amount 4200',
        {
          expiresAt: '2026-11-02T15:30:00.000Z',
        },
      );
    } else if (shape === 'two') {
      conversation = withApproval(
        conversation,
        'refund-4471',
        'issue_refund',
        'refund order 4471 --amount 4200',
      );
      conversation = withApproval(
        conversation,
        'refund-4472',
        'issue_refund',
        'refund order 4472 --amount 1800',
      );
    } else if (shape === 'command') {
      conversation = withApproval(
        conversation,
        'refund-4471',
        'issue_refund',
        'refund order 4471 --amount 4200 --reason "duplicate charge reported by the customer" --notify customer@example.com --ledger october-2026',
      );
    } else if (shape === 'rtl') {
      conversation = withApproval(
        conversation,
        'refund-4471',
        'issue_refund',
        'refund order 4471 --amount 4200',
        {
          message: 'هل توافق على استرداد 42.00 دولار للطلب رقم 4471؟',
        },
      );
      setup.direction = 'rtl';
    } else {
      conversation = withApproval(
        conversation,
        'refund-4471',
        'issue_refund',
        'refund order 4471 --amount 4200',
      );
    }
    setup.conversation = conversation;
    setup.approvalDetails['issue_refund'] = {
      irreversible: shape === 'irreversible' || shape === 'two' || shape === 'command',
      approveLabel: 'Refund $42.00',
      pauseSentence: 'The agent is paused until you decide.',
      facts: [
        { label: 'Target', value: 'order 4471' },
        { label: 'Amount', value: '$42.00' },
      ],
      why: 'The customer was charged twice for the same order.',
    };
    return setup;
  },

  question: (stressCase) => {
    const shape = param<'single' | 'other' | 'three' | 'identifier'>(stressCase, 'shape', 'single');
    let conversation = appendUserMessage(start('stress-question'), 'Deploy the build.');
    const setup = baseSetup(conversation);
    setup.runInput = true;
    if (shape === 'three') {
      conversation = withQuestion(conversation, 'ask-1', 'Which environment?', ENVIRONMENT_SCHEMA);
      conversation = withQuestion(conversation, 'ask-2', 'Which region?', {
        enum: ['east', 'west', 'north'],
      });
      conversation = withQuestion(conversation, 'ask-3', 'Notify the channel?', {
        type: 'boolean',
      });
    } else if (shape === 'other') {
      conversation = withQuestion(
        conversation,
        'ask-1',
        'Which environment?',
        ENVIRONMENT_OR_OTHER_SCHEMA,
      );
    } else if (shape === 'identifier') {
      conversation = withQuestion(
        conversation,
        'ask-1',
        `Which ledger should ${LONG_TOOL} export?`,
        ENVIRONMENT_SCHEMA,
      );
    } else {
      conversation = withQuestion(conversation, 'ask-1', 'Which environment?', ENVIRONMENT_SCHEMA);
    }
    setup.conversation = conversation;
    setup.questionPlacement = param<'inline' | 'docked'>(stressCase, 'placement', 'docked');
    return setup;
  },

  attachments: (stressCase) => {
    const mode = param<'ready' | 'mixed'>(stressCase, 'mode', 'ready');
    const setup = baseSetup(
      plainTurn(
        'stress-attachments',
        'Here are the receipts.',
        'Thanks. Attach the rest when you are ready.',
      ),
    );
    setup.capabilities = { attachments: true };
    setup.uploads = mode === 'mixed' ? 'mixed' : 'ready';
    return setup;
  },

  images: (stressCase) => {
    const mode = param<'broken' | 'image-only'>(stressCase, 'mode', 'broken');
    // The address is a same-origin file the server does not have, so the browser reports a real
    // load error and the thumbnail falls back to its named placeholder.
    const missing = {
      type: 'image' as const,
      source: { kind: 'remote-url' as const, url: '/stress-missing-receipt.png' },
      alt: 'receipt.png',
    };
    const content =
      mode === 'broken'
        ? [{ type: 'text' as const, text: 'Here is the receipt.' }, missing]
        : [missing];
    const setup = baseSetup(appendUserMessage(start('stress-image'), content));
    setup.regenerate = false;
    return setup;
  },

  citations: (stressCase) => {
    const presentation = param<'inline' | 'compact' | 'list'>(stressCase, 'presentation', 'inline');
    const setup = baseSetup(
      plainTurn(
        'stress-citations',
        'Why was order 4471 refunded?',
        'The order was charged twice, and the refund policy allows a full refund in that case.',
      ),
    );
    setup.sources[0] = SAMPLE_SOURCES;
    setup.sourcePresentation = presentation;
    setup.withdrawable = param(stressCase, 'withdrawable', false);
    return setup;
  },

  'missing-source': () => {
    const setup = baseSetup(
      plainTurn(
        'stress-missing-source',
        'Why was order 4471 refunded?',
        'The order was charged twice.',
      ),
    );
    setup.sourcePresentation = 'list';
    setup.sources[0] = [];
    return setup;
  },

  rtl: () => {
    const setup = baseSetup(
      plainTurn(
        'stress-rtl',
        'هل تم استرداد المبلغ 42.00 دولار للطلب 4471؟',
        'نعم، تم استرداد 42.00 دولار للطلب رقم 4471 في 1 نوفمبر.',
      ),
    );
    setup.direction = 'rtl';
    setup.sources[0] = [{ label: 'سياسة الاسترداد', url: 'https://docs.example.com/refunds' }];
    setup.sourcePresentation = 'inline';
    return setup;
  },

  'turn-state': (stressCase) => {
    const initial = param<'streaming' | 'complete'>(stressCase, 'initial', 'streaming');
    let conversation = appendUserMessage(start('stress-turn'), 'Reconcile the October ledger.');
    conversation = withCall(
      conversation,
      'read-ledger',
      'read_ledger',
      { month: 'october' },
      { status: 'ok' },
    );
    conversation = appendAssistantMessage(
      conversation,
      'The October ledger has 212 entries and three of them',
    );
    const setup = baseSetup(conversation);
    setup.streaming = initial === 'streaming';
    setup.runInput = true;
    setup.turnStates[0] = initial === 'streaming' ? { kind: 'streaming' } : { kind: 'complete' };
    return setup;
  },

  reasoning: (stressCase) => {
    const live = param(stressCase, 'live', true);
    const conversation = appendAssistantMessage(
      appendUserMessage(start('stress-reasoning'), 'Should we refund order 4471?'),
      'Yes, the order was charged twice.',
    );
    const setup = baseSetup(conversation);
    setup.streaming = live;
    setup.runInput = true;
    setup.reasoning[0] = {
      content:
        'The ledger shows two captures of $42.00 within four seconds. The policy allows a full refund for a duplicate capture.',
      summary: ['Two captures within four seconds', 'Policy allows a full refund'],
    };
    if (live) setup.turnStates[0] = { kind: 'streaming' };
    return setup;
  },

  'long-transcript': () => {
    let conversation = start('stress-long');
    for (let index = 1; index <= 30; index += 1) {
      conversation = appendUserMessage(
        conversation,
        `Question ${index}: what changed in release ${index}?`,
      );
      conversation = appendAssistantMessage(
        conversation,
        `Release ${index} changed the ledger export and fixed two small defects in the refund screen.`,
      );
    }
    const setup = baseSetup(conversation);
    setup.runInput = true;
    return setup;
  },

  'composer-sweep': () => {
    const setup = baseSetup(
      plainTurn(
        'stress-sweep',
        'Summarize the rollout plan.',
        'The rollout has three phases: canary, staged and general availability.',
      ),
    );
    setup.capabilities = { attachments: true };
    setup.uploads = 'ready';
    return setup;
  },

  'two-composers': () => {
    const setup = baseSetup(
      plainTurn('stress-two-a', 'First chat: status?', 'First chat: all green.'),
    );
    setup.secondChat = true;
    return setup;
  },
};

/** The empty setup the fixture holds while it draws a failure instead of a chat. */
export function failedStressSetup(): StressSetup {
  return baseSetup(start('stress-failed'));
}

/** The names of every scenario a case can use. */
export const STRESS_SCENARIO_NAMES: readonly string[] = Object.keys(scenarios);

/** Builds a case's setup, with stable message ids and times; throws for an unknown scenario. */
export function buildStressSetup(stressCase: StressCase): StressSetup {
  const scenario = Object.hasOwn(scenarios, stressCase.scenario)
    ? scenarios[stressCase.scenario]
    : undefined;
  if (scenario === undefined) {
    throw new Error(
      `Chat stress case ${stressCase.id} names the unknown scenario '${stressCase.scenario}'.`,
    );
  }
  const setup = scenario(stressCase);
  if (stressCase.direction !== undefined) setup.direction = stressCase.direction;
  setup.conversation = stabilize(setup.conversation);
  return setup;
}
