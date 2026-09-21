/**
 * Carries an Operative agent run onto `@lostgradient/chat`'s stream wire.
 *
 * One host runs the agent; another renders it. This is the piece in between:
 * it turns an `AgentRun`'s events into the exact NDJSON frames
 * `decodeChatStreamEvents` expects, and it holds the invariants that make
 * those frames readable — a `sequence` that increases strictly from zero
 * across every frame, exactly one terminal `run.*`, and an error envelope
 * that never carries a provider's raw cause.
 *
 * IT LIVES IN ITS OWN PACKAGE because those invariants are not a host's
 * business to re-derive. It was already shared by two route families inside
 * the retired SvelteKit lab, and the desktop application inherited it whole;
 * a second copy would drift from the first at the first fix that landed in
 * only one of them.
 *
 * WHY NOT UPSTREAM. `@lostgradient/operative` cannot own it without depending on
 * the chat wire, which points the agent runtime at a presentation contract.
 * `@lostgradient/chat` cannot own it without promoting Operative from a
 * development dependency to a runtime one, which would make every browser
 * consumer of `Chat` compile the agent runtime. `conversationalist`
 * owns the message model, not the stream envelope. So this package is the
 * leaf that depends on all three and is depended on by none of them.
 */
export {
  SAFE_CHAT_FAILURE_MESSAGE,
  classifyChatRunFailure,
  createChatAgent,
  createChatStreamWriter,
  startChatRun,
  toChatWireErrorCode,
  type ChatAgent,
  type ChatRunEnvelope,
  type ChatSerializedRunError,
  type ChatStreamFrame,
  type ChatStreamWriter,
} from './chat-agent.ts';

export { pumpChatRun } from './chat-run-pump.ts';

export { isJSONValue, toJSONValue } from './json-value.ts';
