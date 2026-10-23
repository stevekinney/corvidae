/**
 * `@lostgradient/weft/a2a`: serve an agent over the A2A 1.0.1 protocol on top of the
 * official `@a2a-js/sdk` (an optional peer dependency of Weft, pinned to 1.3.0).
 *
 * @module a2a
 */

export {
  createEgressPolicy,
  type EgressDecision,
  type EgressHostResolver,
  type EgressPolicy,
  type EgressPolicyOptions,
} from '../runtime/egress-policy.ts';
export type { A2AAgentCardInput, A2ASigningOptions } from './agent-card-route.ts';
export {
  createA2AHandler,
  type A2AAuthenticate,
  type A2AHandler,
  type A2AHandlerOptions,
} from './handler.ts';
export {
  A2A_NOTIFICATION_TOKEN_HEADER,
  A2A_PUSH_CONTENT_TYPE,
  DEFAULT_HTTP_DELIVERY_TIMEOUT_MS,
  createHttpDeliveryAdapter,
  type HttpDeliveryAdapter,
  type HttpDeliveryAdapterOptions,
  type HttpDeliveryCredential,
} from './http-delivery-adapter.ts';
export {
  DEFAULT_PUSH_DELIVERY_INTERVAL_MS,
  startPushDelivery,
  type StartPushDeliveryOptions,
} from './push-delivery.ts';
export {
  A2A_PUSH_DELIVERY_KIND,
  A2A_PUSH_MAX_ATTEMPTS,
  createOutboxPushNotificationSender,
  pushNotificationResolvers,
  type OutboxPushNotificationSender,
  type OutboxPushNotificationSenderOptions,
} from './push-notification-sender.ts';
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
  type A2ASecurityTransportEvidence,
} from './security-schemes.ts';
export { requestSignalOf } from './sse-response.ts';
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
export {
  createWorkflowAgentCard,
  type WorkflowAgentCardOptions,
  type WorkflowAgentInputMode,
} from './workflow-agent-card.ts';
export {
  createWorkflowAgentExecutor,
  type WorkflowAgent,
  type WorkflowAgentExecutorOptions,
} from './workflow-agent-executor.ts';
export {
  SIGNAL_NAME_METADATA_KEY,
  type WorkflowAgentInput,
  type WorkflowAgentResponder,
} from './workflow-agent-messages.ts';
export {
  RESULT_ARTIFACT_ID,
  SIGNAL_NAMES_METADATA_KEY,
  resultArtifact,
  type WorkflowResultArtifacts,
} from './workflow-task-projection.ts';
