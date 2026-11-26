import type {
  AppBridge,
  McpUiHostContext,
  McpUiResourceCsp,
} from '@modelcontextprotocol/ext-apps/app-bridge';

type ToolHandler = (args: Record<string, unknown>) => unknown;

/** A tool result exactly as the host answers it, errors and their structured content included. */
export type RawToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
};

export type ReferenceHost = {
  calls: { name: string; arguments: Record<string, unknown> }[];
  handlers: Record<string, ToolHandler>;
  /** Handlers returning a complete tool result take precedence over handlers. */
  rawHandlers: Record<
    string,
    (args: Record<string, unknown>) => RawToolResult | Promise<RawToolResult>
  >;
  /** Tools whose call the host does not answer: it fails at the transport, never with a result. */
  unreachable: string[];
  mount(
    html: string,
    csp: McpUiResourceCsp,
    toolInput: Record<string, unknown>,
    title?: string,
    hostContext?: McpUiHostContext,
  ): Promise<void>;
  teardown(): Promise<void>;
  initialized: boolean;
  usePendingReviewHost(): void;
  /** Set before `mount` to give the panel no `serverTools` capability. */
  withoutServerTools?: boolean;
  /** Sent to the panel as the tool result that opened it, once it has initialized. */
  toolResult?: Parameters<AppBridge['sendToolResult']>[0];
};

declare global {
  interface Window {
    referenceHost: ReferenceHost;
  }
}
