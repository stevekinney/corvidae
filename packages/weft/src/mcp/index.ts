/**
 * MCP server support for Weft.
 *
 * This subpath is server/runtime-oriented. The browser-safe entry points are
 * the root `@lostgradient/weft`, `@lostgradient/weft/client`, and
 * `@lostgradient/weft/service-worker`.
 *
 * @module mcp
 */

export {
  anonymousPrincipal,
  principalFromApiKey,
  principalFromJwtClaims,
  principalFromMutualTls,
  principalFromStdioLocal,
  principalFromUnauthenticatedLocal,
} from '../server/principal.ts';
export type {
  AuthenticatedPrincipal,
  JwtClaims,
  Principal,
  UnauthenticatedPrincipal,
} from '../server/principal.ts';
export { McpEndpoint, createMcpEndpoint, handleMcpHttpRequest } from './http.ts';
export type { McpEndpointOptions, McpHttpRequestOptions } from './http.ts';
export { createOperationMcpMount } from './operation-tools.ts';
export type { OperationMcpMountOptions } from './operation-tools.ts';
export {
  DEFAULT_MCP_MAX_BODY_BYTES,
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
} from './protocol.ts';
export type { McpServerContext, McpServerRegistrar } from './server.ts';
export { runMcpStdioSession } from './stdio.ts';
export type { McpStdioAdmission, McpStdioSessionOptions, McpStdioSessionResult } from './stdio.ts';
