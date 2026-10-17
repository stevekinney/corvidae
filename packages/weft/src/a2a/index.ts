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
  securitySchemesFromAuthConfig,
  type A2AAuthConfigShape,
  type A2ASecurityDeclaration,
} from './security-schemes.ts';
export { withStreamEventCursor } from './stream-cursors.ts';
