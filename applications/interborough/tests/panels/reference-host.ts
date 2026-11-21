/**
 * An ext-apps 2.0.x reference host for the run inspector's browser specs (COR-910): the SDK's own
 * `AppBridge` over a `postMessage` transport, a sandboxed `srcdoc` frame under the deny-all policy
 * the resource declares, and tool calls answered from a script the spec controls. It is the page a
 * spec loads; the spec drives it through `window.referenceHost`.
 */
import {
  AppBridge,
  PostMessageTransport,
  type McpUiHostContext,
  type McpUiResourceCsp,
} from '@modelcontextprotocol/ext-apps/app-bridge';

type ToolHandler = (args: Record<string, unknown>) => unknown;

/** A tool result exactly as the host answers it, errors and their structured content included. */
type RawToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type ReferenceHost = {
  calls: { name: string; arguments: Record<string, unknown> }[];
  handlers: Record<string, ToolHandler>;
  /**
   * Handlers whose answer is the whole tool result, consulted before `handlers`: a spec that
   * forwards a call to a running host hands the panel what that host answered, an error and the
   * fault's structured content included.
   */
  rawHandlers: Record<
    string,
    (args: Record<string, unknown>) => RawToolResult | Promise<RawToolResult>
  >;
  mount(
    html: string,
    csp: McpUiResourceCsp,
    toolInput: Record<string, unknown>,
    title?: string,
    hostContext?: McpUiHostContext,
  ): Promise<void>;
  teardown(): Promise<void>;
  initialized: boolean;
  /** Sent to the panel as the tool result that opened it, once it has initialized. */
  toolResult?: Parameters<AppBridge['sendToolResult']>[0];
};

declare global {
  interface Window {
    referenceHost: ReferenceHost;
  }
}

function policy(csp: McpUiResourceCsp): string {
  const none = (list: readonly string[] | undefined): string =>
    list === undefined || list.length === 0 ? "'none'" : list.join(' ');
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    `connect-src ${none(csp.connectDomains)}`,
    `frame-src ${none(csp.frameDomains)}`,
    `base-uri ${none(csp.baseUriDomains)}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join('; ');
}

let bridge: AppBridge | undefined;
let frame: HTMLIFrameElement | undefined;

const host: ReferenceHost = {
  calls: [],
  handlers: {},
  rawHandlers: {},
  initialized: false,
  async mount(html, csp, toolInput, title = 'Run inspector', hostContext) {
    frame = document.createElement('iframe');
    frame.title = title;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy(csp).replaceAll('"', '&quot;')}">${html}`;
    document.body.append(frame);
    bridge = new AppBridge(
      null,
      { name: 'reference-host', version: '1.0.0' },
      {
        serverTools: {},
        sandbox: { permissions: {}, csp },
      },
      // The theme and style variables the host sends: what a panel follows (COR-2218).
      hostContext === undefined ? undefined : { hostContext },
    );
    bridge.oninitialized = () => {
      host.initialized = true;
      void bridge?.sendToolInput({ arguments: toolInput });
      // The result that opened the page, for a panel that starts from one (COR-2218).
      if (host.toolResult !== undefined) void bridge?.sendToolResult(host.toolResult);
    };
    bridge.oncalltool = async (params): ReturnType<NonNullable<AppBridge['oncalltool']>> => {
      host.calls.push({ name: params.name, arguments: params.arguments ?? {} });
      const raw = host.rawHandlers[params.name];
      if (raw !== undefined) {
        try {
          return await raw(params.arguments ?? {});
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: String(error) }] };
        }
      }
      const handler = host.handlers[params.name];
      if (handler === undefined) {
        return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
      }
      let value: unknown;
      try {
        value = await handler(params.arguments ?? {});
      } catch (error) {
        // A handler that throws is a tool that answered with an error.
        return { isError: true, content: [{ type: 'text', text: String(error) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value as Record<string, unknown>,
      };
    };
    const window_ = frame.contentWindow;
    if (window_ === null) throw new Error('The frame has no window');
    await bridge.connect(new PostMessageTransport(window_, window_));
  },
  async teardown() {
    await bridge?.teardownResource({});
    frame?.remove();
    await bridge?.close();
    bridge = undefined;
  },
};
window.referenceHost = host;
