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
import { pluginToolCaller } from '../../src/lib/host-panels.ts';
import type { RawToolResult, ReferenceHost } from './reference-host.types.ts';

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
  unreachable: [],
  initialized: false,
  usePendingReviewHost() {
    const call = pluginToolCaller('inspectors', 'pending-review');
    for (const name of ['bureau.reviews.list', 'bureau.reviews.get', 'bureau.reviews.resolve']) {
      this.rawHandlers[name] = async (argumentsValue) =>
        (await call(
          { name, arguments: argumentsValue },
          { signal: new AbortController().signal },
        )) as RawToolResult;
    }
  },
  async mount(html, csp, toolInput, title = 'Run inspector', hostContext) {
    frame = document.createElement('iframe');
    frame.title = title;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy(csp).replaceAll('"', '&quot;')}">${html}`;
    // A spec that captures the panel for the design review gives the host page an outlet to hold
    // the frame in, as the application's shell holds a page; any other spec has none.
    (document.getElementById('host-outlet') ?? document.body).append(frame);
    bridge = new AppBridge(
      null,
      { name: 'reference-host', version: '1.0.0' },
      {
        // A host that does not let a panel call the server omits the capability (a spec sets this).
        ...(host.withoutServerTools ? {} : { serverTools: {} }),
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
      // A host that does not answer: the request is refused at the transport, so the panel's call
      // rejects, which is not the same as a tool that answers with an error.
      if (host.unreachable.includes(params.name)) throw new Error('The host did not answer.');
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
