/**
 * Chat adapter seam — the optional event/transport boundary around `<Chat>`.
 *
 * Type-only; see `./chat-adapter.ts`.
 *
 * @module
 */

export type {
  ChatAdapter,
  ChatAdapterErrorEvent,
  ChatApprovalDetails,
  ChatCommand,
  ChatPushHandlers,
  ChatReadReceiptEvent,
  ChatToolApprovalResolution,
  ChatToolResult,
} from './chat-adapter.ts';
