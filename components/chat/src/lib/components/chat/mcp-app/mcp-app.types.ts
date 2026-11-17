import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/client';
import type {
  McpUiHostContext,
  McpUiResourceMeta,
  McpUiResourcePermissions,
  McpUiToolInputNotification,
  McpUiToolResultNotification,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import type { Snippet } from 'svelte';

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

/**
 * Host-supplied callback for an app's `ui/open-link` request. It receives the path, query and
 * hash of a link that stays inside this application, and answers whether it opened it. A link to
 * any other origin never reaches it.
 */
export type McpAppOpenLinkHandler = (path: string) => boolean;

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
  /** Largest height, in pixels, the app may resize itself to. Defaults to 600. Ignored with `fill`. */
  maxHeight?: number;
  /**
   * Makes the frame take its container's height, with no `maxHeight` cap: the app scrolls inside
   * itself, and the height it reports does not resize the frame. The container must have a height.
   */
  fill?: boolean;
  /**
   * The page the caller already loaded, used with `fill` so the component draws no loading of its
   * own: the first load takes it instead of calling `loadResource`, and "Try again" after a failure
   * loads afresh. Ignored without `fill`.
   */
  preloadedResource?: McpAppResource;
  /**
   * Receives an app's `ui/open-link` request, and only for a link that stays inside this
   * application (the same origin as the page). It gets the link's path, query and hash, and says
   * whether it opened it. Without it, `ui/open-link` is refused.
   */
  onOpenLink?: McpAppOpenLinkHandler;
  /**
   * Called when `onOpenLink` is set and a link is refused: a foreign origin, an address that does
   * not parse, a handler that said no, or one that threw. It carries no address.
   */
  onOpenLinkRefused?: () => void;
  /**
   * What the failure state says beside "Couldn’t open <title>".
   * @default "Nothing you did caused it."
   */
  errorDescription?: string;
  /** A second action beside "Try again" in the failure state, such as a link to where the cause can be read. */
  errorAction?: Snippet;
  /** Called when the app asks the host to tear it down. */
  onRequestTeardown?: () => void;
  /** Called when loading the resource or connecting the bridge fails. */
  onError?: (error: Error) => void;
  /** Extra class for the frame. */
  class?: string;
};
