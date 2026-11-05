import { createAgentSession } from '@lostgradient/operative';
import {
  appendAssistantMessage,
  appendUserMessage,
  createConversationHistory,
} from 'conversationalist';
import { describe, expect, it } from 'bun:test';

import { historyBefore, holdsPendingApproval, rewoundSession } from './session-rewind';

const HISTORY = appendAssistantMessage(
  appendUserMessage(createConversationHistory({ id: 'thread' }), 'refund 4471'),
  'On it.',
);

function sessionWith(metadata: Record<string, unknown> = {}) {
  const history = HISTORY;
  return createAgentSession({
    id: 'thread',
    agentName: 'agent',
    conversationHistory: history,
    metadata: metadata as never,
  });
}

const [FIRST, SECOND] = sessionWith().conversationHistory.ids as [string, string];

describe('historyBefore', () => {
  it('cuts the row and everything after it', () => {
    const cut = historyBefore(sessionWith().conversationHistory, SECOND);

    expect(cut?.removed).toEqual([SECOND]);
    expect(cut?.history.ids).toEqual([FIRST]);
    expect(Object.keys(cut?.history.messages ?? {})).toEqual([FIRST]);
  });

  it('answers undefined for a row the history does not hold, and for a name that only the prototype has', () => {
    const history = sessionWith().conversationHistory;

    expect(historyBefore(history, 'missing')).toBeUndefined();
    expect(historyBefore(history, 'constructor')).toBeUndefined();
  });
});

describe('rewoundSession', () => {
  it('matches a grant by the tool name whatever its namespace or version, and keeps the rest', () => {
    const session = sessionWith({ approvalGrants: ['shop:issue_refund@2', 'lookup_order'] });

    const rewound = rewoundSession(session, {
      fromMessageId: FIRST,
      forgetGrantsFor: ['issue_refund'],
    });

    expect(rewound?.forgotten).toEqual(['shop:issue_refund@2']);
    expect(rewound?.session.metadata['approvalGrants']).toEqual(['lookup_order']);
    expect(rewound?.session.conversationHistory.ids).toEqual([]);
  });

  it('leaves the grants alone when no tool is named', () => {
    const session = sessionWith({ approvalGrants: ['issue_refund'] });

    const rewound = rewoundSession(session, { fromMessageId: SECOND });

    expect(rewound?.forgotten).toEqual([]);
    expect(rewound?.session.metadata).toBe(session.metadata);
  });
});

describe('holdsPendingApproval', () => {
  const metadata = (expiresAt: unknown) => ({
    pendingApprovalOverrides: { 'approval:run-1:call-1': { approvalBinding: { expiresAt } } },
  });

  it('holds an approval of the run that has not expired, or that carries no expiry', () => {
    expect(holdsPendingApproval(metadata(2_000), 'run-1', 1_000)).toBe(true);
    expect(holdsPendingApproval(metadata(undefined), 'run-1', 1_000)).toBe(true);
  });

  it('does not hold an expired approval, another run’s, or none', () => {
    expect(holdsPendingApproval(metadata(500), 'run-1', 1_000)).toBe(false);
    expect(holdsPendingApproval(metadata(2_000), 'run-2', 1_000)).toBe(false);
    expect(holdsPendingApproval({}, 'run-1', 1_000)).toBe(false);
  });
});
