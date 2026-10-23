/**
 * An ext-apps 2.0.x reference host for the run inspector's browser specs (COR-910): the SDK's own
 * `AppBridge` over a `postMessage` transport, a sandboxed `srcdoc` frame under the deny-all policy
 * the resource declares, and tool calls answered from a script the spec controls. It is the page a
 * spec loads; the spec drives it through `window.referenceHost`.
 */
import {
  AppBridge,
  PostMessageTransport,
  type McpUiResourceCsp,
} from '@modelcontextprotocol/ext-apps/app-bridge';

type ToolHandler = (args: Record<string, unknown>) => unknown;

type ReferenceHost = {
  calls: { name: string; arguments: Record<string, unknown> }[];
  handlers: Record<string, ToolHandler>;
  mount(
    html: string,
    csp: McpUiResourceCsp,
    toolInput: Record<string, unknown>,
    title?: string,
  ): Promise<void>;
  teardown(): Promise<void>;
  initialized: boolean;
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
  initialized: false,
  async mount(html, csp, toolInput, title = 'Run inspector') {
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
    );
    bridge.oninitialized = () => {
      host.initialized = true;
      void bridge?.sendToolInput({ arguments: toolInput });
    };
    bridge.oncalltool = async (params): ReturnType<NonNullable<AppBridge['oncalltool']>> => {
      host.calls.push({ name: params.name, arguments: params.arguments ?? {} });
      const handler = host.handlers[params.name];
      if (handler === undefined) {
        return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
      }
      let value: unknown;
      try {
        value = handler(params.arguments ?? {});
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
