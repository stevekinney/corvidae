// Type-level contract for COR-1476's `sessionId`/`sessionInput` pairing on
// `RunOptions`: a session input gate names the session its deliveries belong
// to, so a gate with no session id is rejected at construction, the way a
// steering gate with no `runId` is. This file is checked by `tsc`; it is not a
// runtime Bun test.

import type { ConversationHistory } from 'conversationalist';

import type { SessionInputGate } from './durable/types';
import type { AnyToolbox, GenerateFunction, RunOptions } from './types';

declare const generate: GenerateFunction;
declare const toolbox: AnyToolbox;
declare const conversation: ConversationHistory;
declare const gate: SessionInputGate;

// A gate with its session is the shape the durable workflow runs.
const paired: RunOptions = {
  generate,
  toolbox,
  conversation,
  sessionId: 'session-1',
  sessionInput: gate,
};
void paired;

// A session with no gate is an ordinary run that belongs to a session.
const sessionOnly: RunOptions = { generate, toolbox, conversation, sessionId: 'session-1' };
void sessionOnly;

// A run with neither is unaffected.
const plain: RunOptions = { generate, toolbox, conversation };
void plain;

// A definite session id lets a possibly-absent gate through unbranched.
declare const maybeGate: SessionInputGate | undefined;
const forwarded: RunOptions = {
  generate,
  toolbox,
  conversation,
  sessionId: 'session-1',
  sessionInput: maybeGate,
};
void forwarded;

// @ts-expect-error — a gate without a session id satisfies neither arm.
const unpaired: RunOptions = { generate, toolbox, conversation, sessionInput: gate };
void unpaired;

// @ts-expect-error — the pairing cannot be undone through a typed reference.
paired.sessionId = undefined;
