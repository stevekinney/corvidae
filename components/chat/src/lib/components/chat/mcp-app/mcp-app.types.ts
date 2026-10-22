import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/client';
import type {
  McpUiHostContext,
  McpUiResourceMeta,
  McpUiResourcePermissions,
  McpUiToolInputNotification,
  McpUiToolResultNotification,
} from '@modelcontextprotocol/ext-apps/app-bridge';

/** An MCP App's `ui://` resource as the host fetched it: its HTML and its declared `_meta.ui`. */
export type McpAppResource = {
  /** The HTML document the app ships. */
  html: string;
  /** The `_meta.ui` block of the resource: declared CSP and requested permissions. */
  ui?: McpUiResourceMeta | undefined;
};

/** Host-supplied loader that fetches a `ui://` resource. The component owns no MCP client. */
export type McpAppResourceLoader = (
  uri: string,
  options: { signal: AbortSignal },
) => Promise<McpAppResource>;

/**
 * Host-supplied callback and the only path by which an app-initiated `tools/call` reaches the
 * outside world.
 */
export type McpAppToolCallHandler = (
  params: CallToolRequest['params'],
  options: { signal: AbortSignal },
) => Promise<CallToolResult>;

/** Props for the `McpApp` component. */
export type McpAppProps = {
  /** The `ui://` URI of the app's resource, passed to `loadResource`. */
  resourceUri: string;
  /** Fetches the resource HTML and its declared CSP. */
  loadResource: McpAppResourceLoader;
  /** Receives every app-initiated tool call. Without it, such calls are rejected. */
  onToolCall?: McpAppToolCallHandler;
  /** Arguments of the tool call that produced the app, sent once the app initializes. */
  toolInput?: McpUiToolInputNotification['params'];
  /** Result of that tool call, sent once the app initializes and again whenever it changes. */
  toolResult?: McpUiToolResultNotification['params'];
  /** Host context offered to the app. Only these fields, plus fixed display defaults, are sent. */
  hostContext?: McpUiHostContext;
  /**
   * Permissions the host is willing to grant. A permission reaches the iframe only when the
   * resource requests it and the host grants it; everything else is denied.
   */
  grantedPermissions?: McpUiResourcePermissions;
  /** Accessible name of the frame. */
  title?: string;
  /** Largest height, in pixels, the app may resize itself to. Defaults to 600. */
  maxHeight?: number;
  /** Called when the app asks the host to tear it down. */
  onRequestTeardown?: () => void;
  /** Called when loading the resource or connecting the bridge fails. */
  onError?: (error: Error) => void;
  /** Extra class for the frame. */
  class?: string;
};
