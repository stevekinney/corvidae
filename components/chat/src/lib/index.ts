import ChatComponent from './components/chat/index.ts';

export default ChatComponent;
export { default as A2uiSurface } from './a2ui/a2ui-surface.svelte';
export {
  A2UI_SURFACE_CATALOG_ID,
  A2UI_SURFACE_CLIENT_CAPABILITIES,
} from './a2ui/client-capabilities.ts';
export type {
  A2uiAction,
  A2uiActionEvent,
  A2uiAssetUrlResolver,
  A2uiComponent,
  A2uiDiagnostic,
  A2uiDiagnosticCode,
  A2uiJsonValue,
  A2uiSurfaceProps,
} from './a2ui/types.ts';
export {
  deserializeChatComposerMention,
  parseChatComposerMentions,
  serializeChatComposerMention,
  type ChatComposerMention,
  type ChatComposerMentionParseResult,
  type ChatComposerMentionRange,
} from './components/chat-composer-popover/chat-composer-mention.ts';
export * from './components/chat/index.ts';
export {
  AGUIChatTransportError,
  AG_UI_UNSUPPORTED_EVENT_TYPES,
  UNSTARTED_RUN_ID,
  createAGUIChatTransport,
  mapAGUIEventsToChatStream,
  type AGUIChatTransportErrorKind,
} from './session/ag-ui-transport.ts';
export { assertRunInputAccepted } from './session/session-controller-run-input-receipt.ts';
export {
  ChatRunFailureError,
  type ChatElicitationActivity,
  type ChatExecutionOwner,
  type ChatHistoryToken,
  type ChatRunAbortedNotice,
  type ChatSessionController,
  type ChatSessionControllerOptions,
  type ChatSessionHooks,
  type ChatSessionRequest,
  type ChatSessionRunInput,
  type ChatSessionRunInputOptions,
  type ChatSessionRunInputReceipt,
  type ChatSessionTransport,
  type ChatSessionTransportResult,
  type ChatToolActivity,
} from './session/session-controller-support.ts';
export {
  createChatSession,
  createChatSessionController,
  createSessionController,
} from './session/session-controller.ts';
export {
  decodeChatStreamEvent,
  decodeChatStreamEvents,
  decodeStreamEvent,
  decodeStreamEvents,
  encodeChatStreamEvent,
  encodeStreamEvent,
  guardChatStreamEvents,
  type ChatSerializedRunError,
  type ChatStreamDecodeOptions,
  type ChatStreamEvent,
} from './session/stream-event-codec.ts';
