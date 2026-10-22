import type { CallToolResult } from '@modelcontextprotocol/client';
import {
  AppBridge,
  PostMessageTransport,
  type McpUiHostCapabilities,
  type McpUiHostContext,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
  type McpUiToolInputNotification,
  type McpUiToolResultNotification,
} from '@modelcontextprotocol/ext-apps/app-bridge';

import { sanitizeDeclaredSources } from './mcp-app-content-security-policy.ts';
import type { McpAppToolCallHandler } from './mcp-app.types.ts';

const PERMISSION_NAMES = ['camera', 'microphone', 'geolocation', 'clipboardWrite'] as const;

/**
 * The permissions an iframe may actually use: those the resource declared that the host also
 * granted. A declared permission nobody granted, and a granted one nobody declared, are both
 * denied.
 */
export function resolveMcpAppPermissions(
  declared: McpUiResourcePermissions | undefined,
  granted: McpUiResourcePermissions | undefined,
): McpUiResourcePermissions {
  const resolved: McpUiResourcePermissions = {};
  for (const name of PERMISSION_NAMES) {
    if (declared?.[name] !== undefined && granted?.[name] !== undefined) resolved[name] = {};
  }
  return resolved;
}

/** Everything a bridge needs from its host. */
export type McpAppBridgeOptions = {
  /** The iframe's `contentWindow`: the only recipient of host messages and the only accepted source. */
  frameWindow: Window;
  /** CSP the resource declared; advertised to the app as the CSP the host applied. */
  csp?: McpUiResourceCsp | undefined;
  /** Permissions that survived {@link resolveMcpAppPermissions}. */
  permissions: McpUiResourcePermissions;
  /** Host context returned from `ui/initialize`. */
  hostContext: McpUiHostContext;
  /** The host's tool-call callback. With none, the bridge does not answer `tools/call`. */
  onToolCall?: McpAppToolCallHandler | undefined;
  /** Called when the app reports a new content height. */
  onSizeChange: (height: number) => void;
  /** Called when the app finishes the initialize handshake. */
  onInitialized: () => void;
  /** Called when the app asks to be torn down. */
  onRequestTeardown: () => void;
};

/** A host-side connection to one MCP App iframe. */
export type McpAppBridge = {
  /** Starts listening for the app. Resolves once the message listener is installed. */
  connect(): Promise<void>;
  /** Sends the arguments of the tool call that produced the app. */
  sendToolInput(params: McpUiToolInputNotification['params']): Promise<void>;
  /** Sends the result of that tool call. */
  sendToolResult(params: McpUiToolResultNotification['params']): Promise<void>;
  /** Replaces the host context and notifies the app of the fields that changed. */
  setHostContext(hostContext: McpUiHostContext): void;
  /**
   * Asks the app to tear down, then synchronously removes the window `message` listener and
   * aborts every in-flight app-initiated tool call. Safe to call more than once.
   */
  close(): void;
};

/**
 * Creates the host half of the `@modelcontextprotocol/ext-apps` protocol for one iframe, on
 * the library's {@link AppBridge} with no MCP client attached. The only handler that reaches
 * outside the page is `tools/call`, and it reaches only `options.onToolCall`. Requests the host
 * did not opt into (`ui/open-link`, `ui/message`, `resources/read`, sampling, and the rest) get
 * the protocol's method-not-found error.
 */
export function createMcpAppBridge(options: McpAppBridgeOptions): McpAppBridge {
  const capabilities: McpUiHostCapabilities = {
    sandbox: {
      permissions: options.permissions,
      csp: {
        connectDomains: sanitizeDeclaredSources(options.csp?.connectDomains),
        resourceDomains: sanitizeDeclaredSources(options.csp?.resourceDomains),
        frameDomains: sanitizeDeclaredSources(options.csp?.frameDomains),
        baseUriDomains: sanitizeDeclaredSources(options.csp?.baseUriDomains),
      },
    },
  };
  if (options.onToolCall !== undefined) capabilities.serverTools = {};

  const bridge = new AppBridge(
    null,
    { name: 'lostgradient-chat', version: '0.0.0' },
    capabilities,
    { hostContext: options.hostContext },
  );
  const transport = new PostMessageTransport(options.frameWindow, options.frameWindow);
  const pending = new Set<AbortController>();
  let closed = false;

  bridge.addEventListener('sizechange', ({ height }) => {
    if (typeof height === 'number' && Number.isFinite(height) && height >= 0) {
      options.onSizeChange(height);
    }
  });
  bridge.addEventListener('initialized', () => options.onInitialized());
  bridge.addEventListener('requestteardown', () => options.onRequestTeardown());

  const onToolCall = options.onToolCall;
  if (onToolCall !== undefined) {
    // The SDK validates `params` against the `tools/call` schema before this runs.
    bridge.oncalltool = async (params, extra) => {
      const controller = new AbortController();
      pending.add(controller);
      extra.mcpReq.signal.addEventListener('abort', () => controller.abort(), { once: true });
      try {
        return await onToolCall(params, { signal: controller.signal });
      } catch {
        const failure: CallToolResult = {
          content: [{ type: 'text', text: 'The host could not complete the tool call.' }],
          isError: true,
        };
        return failure;
      } finally {
        pending.delete(controller);
      }
    };
  }

  return {
    connect: () => bridge.connect(transport),
    sendToolInput: (params) => bridge.sendToolInput(params),
    sendToolResult: (params) => bridge.sendToolResult(params),
    setHostContext: (hostContext) => bridge.setHostContext(hostContext),
    close() {
      if (closed) return;
      closed = true;
      // Queue the teardown request before the listener goes away; the answer is not awaited.
      bridge.teardownResource({}, { timeout: 1 }).catch(() => {});
      for (const controller of pending) controller.abort();
      pending.clear();
      void transport.close();
    },
  };
}
