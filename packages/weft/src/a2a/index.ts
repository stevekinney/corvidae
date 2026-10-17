/**
 * `@lostgradient/weft/a2a`: serve an agent over the A2A 1.0.1 protocol on top of the
 * official `@a2a-js/sdk` (an optional peer dependency of Weft, pinned to 1.3.0).
 *
 * @module a2a
 */

export type { A2AAgentCardInput, A2ASigningOptions } from './agent-card-route.ts';
export {
  createA2AHandler,
  type A2AAuthenticate,
  type A2AHandler,
  type A2AHandlerOptions,
} from './handler.ts';
export {
  createWeftPushNotificationStore,
  type WeftPushNotificationListRequest,
  type WeftPushNotificationStore,
  type WeftPushNotificationStoreOptions,
} from './push-notification-store.ts';
export {
  REDACTED_PUSH_CREDENTIALS,
  withRedactedPushConfigurations,
} from './redact-push-configurations.ts';
export {
  securitySchemesFromAuthConfig,
  type A2AAuthConfigShape,
  type A2ASecurityDeclaration,
} from './security-schemes.ts';
export {
  A2APushConfigurationConflictError,
  A2AStoreConflictError,
  A2AStorePageSizeError,
  A2AStorePageTokenError,
  A2AStoreRecordVersionError,
} from './store-errors.ts';
export { withStreamEventCursor } from './stream-cursors.ts';
export {
  DEFAULT_A2A_TERMINAL_RETENTION_MS,
  createWeftA2ATaskStore,
  type WeftA2ATaskStore,
  type WeftA2ATaskStoreOptions,
} from './task-store.ts';
