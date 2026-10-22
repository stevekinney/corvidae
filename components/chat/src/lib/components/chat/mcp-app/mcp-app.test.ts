/// <reference lib="dom" />
import type { CallToolResult } from '@modelcontextprotocol/client';
import { render } from '@testing-library/svelte';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';

import McpApp from './mcp-app.svelte';
import type { McpAppProps, McpAppResource, McpAppToolCallHandler } from './mcp-app.types.ts';

type FrameMessage = { jsonrpc?: string; id?: number; method?: string; result?: unknown } & Record<
  string,
  unknown
>;

/** Every payload the host posts to the iframe, in order. */
let framePayloads: FrameMessage[] = [];
const frameWindows = new WeakMap<object, { postMessage: (message: FrameMessage) => void }>();
const originalContentWindow = Object.getOwnPropertyDescriptor(
  HTMLIFrameElement.prototype,
  'contentWindow',
);

function frameWindowOf(frame: HTMLIFrameElement): { postMessage: (message: FrameMessage) => void } {
  const existing = frameWindows.get(frame);
  if (existing !== undefined) return existing;
  const created = { postMessage: (message: FrameMessage) => void framePayloads.push(message) };
  frameWindows.set(frame, created);
  return created;
}

let debug: ReturnType<typeof spyOn<Console, 'debug'>>;

// The ext-apps transport logs every message at debug level.
beforeAll(() => {
  debug = spyOn(console, 'debug').mockImplementation(() => {});
});

afterAll(() => {
  debug.mockRestore();
});

beforeEach(() => {
  framePayloads = [];
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get(this: HTMLIFrameElement) {
      return frameWindowOf(this);
    },
  });
});

afterEach(() => {
  if (originalContentWindow === undefined) {
    Reflect.deleteProperty(HTMLIFrameElement.prototype, 'contentWindow');
  } else {
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', originalContentWindow);
  }
});

const RESOURCE: McpAppResource = {
  html: '<!doctype html><html><head><title>App</title></head><body>hi</body></html>',
  ui: {
    csp: {
      connectDomains: ['https://api.example.com'],
      resourceDomains: ['https://cdn.example.com'],
    },
  },
};

async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountApp(overrides: Partial<McpAppProps> = {}, resource = RESOURCE) {
  const view = render(McpApp, {
    props: {
      resourceUri: 'ui://weather/forecast',
      loadResource: async () => resource,
      ...overrides,
    },
  });
  await settle();
  const frame = view.container.querySelector('iframe');
  if (frame === null) throw new Error('The MCP App iframe did not render.');
  return { ...view, frame, source: frameWindowOf(frame) };
}

/** Plays the app: posts a JSON-RPC message to the host from the iframe's window. */
function fromApp(source: object, data: Record<string, unknown>): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { jsonrpc: '2.0', ...data },
      source: source as MessageEventSource,
    }),
  );
}

async function handshake(source: object): Promise<void> {
  fromApp(source, {
    id: 1,
    method: 'ui/initialize',
    params: {
      appInfo: { name: 'fixture-app', version: '1.0.0' },
      appCapabilities: {},
      protocolVersion: '2026-01-26',
    },
  });
  await settle();
  fromApp(source, { method: 'ui/notifications/initialized' });
  await settle();
}

function responseTo(id: number): FrameMessage | undefined {
  return framePayloads.find((message) => message.id === id && !('method' in message));
}

describe('McpApp frame', () => {
  test('sandboxes with allow-scripts only, loads through srcdoc, and applies the declared CSP first', async () => {
    const { frame } = await mountApp();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.hasAttribute('src')).toBe(false);
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(
      srcdoc.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"'),
    ).toBe(true);
    expect(srcdoc).toContain('connect-src https://api.example.com');
    expect(srcdoc).toContain("script-src 'unsafe-inline' https://cdn.example.com");
    expect(srcdoc).toContain(RESOURCE.html);
  });

  test('denies every network path when the resource declares no CSP', async () => {
    const { frame } = await mountApp({}, { html: '<p>no csp</p>' });
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain("frame-src 'none'");
    expect(srcdoc).toContain("base-uri 'none'");
    expect(srcdoc).not.toMatch(/https?:/);
  });

  test('shows an error state and reports it when the resource cannot be loaded', async () => {
    const onError = mock((_error: Error) => {});
    const view = render(McpApp, {
      props: {
        resourceUri: 'ui://missing',
        loadResource: async () => {
          throw new Error('no such resource');
        },
        onError,
      },
    });
    await settle();
    expect(view.container.querySelector('iframe')).toBeNull();
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('McpApp host protocol', () => {
  test('answers ui/initialize, then sends tool input and result once the app is initialized', async () => {
    const { source } = await mountApp({
      toolInput: { arguments: { city: 'Lisbon' } },
      toolResult: { content: [{ type: 'text', text: '18C' }] },
      hostContext: { theme: 'dark' },
    });
    await handshake(source);
    const initialize = responseTo(1);
    expect(initialize?.result).toMatchObject({
      protocolVersion: '2026-01-26',
      hostInfo: { name: 'lostgradient-chat' },
      hostContext: { theme: 'dark', displayMode: 'inline', platform: 'web' },
    });
    const methods = framePayloads.map((message) => message.method).filter(Boolean);
    expect(methods).toContain('ui/notifications/tool-input');
    expect(methods).toContain('ui/notifications/tool-result');
  });

  test('routes an app-initiated tools/call only through the host callback', async () => {
    const result: CallToolResult = { content: [{ type: 'text', text: 'sunny' }] };
    const onToolCall = mock<McpAppToolCallHandler>(async () => result);
    const { source } = await mountApp({ onToolCall });
    await handshake(source);
    fromApp(source, {
      id: 7,
      method: 'tools/call',
      params: { name: 'get_weather', arguments: { city: 'Lisbon' } },
    });
    await settle();
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall.mock.calls[0]?.[0]).toEqual({
      name: 'get_weather',
      arguments: { city: 'Lisbon' },
    });
    expect(responseTo(7)?.result).toEqual(result);
  });

  test('reports a failing callback to the app without leaking its error', async () => {
    const onToolCall = mock(async () => {
      throw new Error('secret connection string');
    });
    const { source } = await mountApp({ onToolCall });
    await handshake(source);
    fromApp(source, { id: 8, method: 'tools/call', params: { name: 'get_weather' } });
    await settle();
    expect(responseTo(8)?.result).toMatchObject({ isError: true });
    expect(JSON.stringify(framePayloads)).not.toContain('secret connection string');
  });

  test('rejects a malformed tools/call before it reaches the callback', async () => {
    const onToolCall = mock(async () => ({ content: [] }));
    const { source } = await mountApp({ onToolCall });
    await handshake(source);
    fromApp(source, { id: 9, method: 'tools/call', params: { arguments: {} } });
    await settle();
    expect(onToolCall).not.toHaveBeenCalled();
    expect(framePayloads.find((message) => message.id === 9)).toHaveProperty('error');
  });

  test('refuses tools/call and every unopted-in host method', async () => {
    const { source } = await mountApp();
    await handshake(source);
    const refused = [
      'tools/call',
      'ui/open-link',
      'ui/message',
      'resources/read',
      'sampling/createMessage',
    ];
    refused.forEach((method, index) => {
      fromApp(source, {
        id: 20 + index,
        method,
        params: { name: 'x', url: 'https://example.com', role: 'user', content: [], uri: 'ui://x' },
      });
    });
    await settle();
    refused.forEach((_method, index) => {
      expect(framePayloads.find((message) => message.id === 20 + index)).toHaveProperty('error');
    });
  });

  test('ignores messages that do not come from its own iframe', async () => {
    const onToolCall = mock(async () => ({ content: [] }));
    await mountApp({ onToolCall });
    fromApp({}, { id: 5, method: 'tools/call', params: { name: 'x' } });
    await settle();
    expect(onToolCall).not.toHaveBeenCalled();
    expect(framePayloads.find((message) => message.id === 5)).toBeUndefined();
  });

  test('resizes the frame to the height the app reports, capped at maxHeight', async () => {
    const { frame, source } = await mountApp({ maxHeight: 300 });
    await handshake(source);
    fromApp(source, { method: 'ui/notifications/size-changed', params: { height: 180 } });
    await settle();
    expect(frame.style.height).toBe('180px');
    fromApp(source, { method: 'ui/notifications/size-changed', params: { height: 5000 } });
    await settle();
    expect(frame.style.height).toBe('300px');
  });

  test('forwards the app request to tear down to the host', async () => {
    const onRequestTeardown = mock(() => {});
    const { source } = await mountApp({ onRequestTeardown });
    await handshake(source);
    fromApp(source, { method: 'ui/notifications/request-teardown', params: {} });
    await settle();
    expect(onRequestTeardown).toHaveBeenCalledTimes(1);
  });
});

describe('McpApp permissions', () => {
  const requesting: McpAppResource = {
    html: '<p>camera app</p>',
    ui: { permissions: { camera: {}, geolocation: {} } },
  };

  test('denies a permission the resource requests when the host does not grant it', async () => {
    const { frame, source } = await mountApp({}, requesting);
    expect(frame.hasAttribute('allow')).toBe(false);
    await handshake(source);
    expect(responseTo(1)?.result).toMatchObject({
      hostCapabilities: { sandbox: { permissions: {} } },
    });
  });

  test('grants only the permissions that are both requested and granted', async () => {
    const { frame, source } = await mountApp(
      { grantedPermissions: { camera: {}, microphone: {} } },
      requesting,
    );
    expect(frame.getAttribute('allow')).toBe('camera');
    await handshake(source);
    expect(responseTo(1)?.result).toMatchObject({
      hostCapabilities: { sandbox: { permissions: { camera: {} } } },
    });
    const result = responseTo(1)?.result as
      { hostCapabilities?: { sandbox?: { permissions?: object } } } | undefined;
    expect(result?.hostCapabilities?.sandbox?.permissions).toEqual({ camera: {} });
  });
});

describe('McpApp data handed to the iframe', () => {
  test('sends nothing but protocol messages and host-supplied fields', async () => {
    const credential = 'sk-live-4f9a1c0e7b2d';
    document.cookie = `session=${credential}`;
    localStorage.setItem('access_token', credential);
    const conversation = 'conversation-secret: the user asked about their salary';
    const conversationElement = document.createElement('p');
    conversationElement.textContent = conversation;
    document.body.append(conversationElement);

    const { source } = await mountApp({
      toolInput: { arguments: { city: 'Lisbon' } },
      toolResult: { content: [{ type: 'text', text: '18C' }] },
      hostContext: { theme: 'light', locale: 'en-US' },
      onToolCall: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    await handshake(source);
    fromApp(source, { id: 3, method: 'tools/call', params: { name: 'get_weather' } });
    await settle();

    const allowedMethods = new Set([
      undefined, // a response to an app request
      'ui/notifications/tool-input',
      'ui/notifications/tool-result',
      'ui/notifications/host-context-changed',
    ]);
    expect(framePayloads.length).toBeGreaterThanOrEqual(4);
    for (const message of framePayloads) {
      expect(allowedMethods.has(message.method)).toBe(true);
      expect(message.jsonrpc).toBe('2.0');
    }
    const everything = JSON.stringify(framePayloads);
    expect(everything).not.toContain(credential);
    expect(everything).not.toContain('salary');
    expect(everything).not.toContain('session=');
    expect(everything).not.toContain('access_token');
    expect(everything).toContain('Lisbon');
    localStorage.removeItem('access_token');
    conversationElement.remove();
  });
});

describe('McpApp teardown', () => {
  test('removes the iframe and every message listener it added when unmounted', async () => {
    const added: EventListenerOrEventListenerObject[] = [];
    const removed: EventListenerOrEventListenerObject[] = [];
    const add = spyOn(window, 'addEventListener').mockImplementation(((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'message') added.push(listener);
      EventTarget.prototype.addEventListener.call(window, type, listener, options);
    }) as typeof window.addEventListener);
    const remove = spyOn(window, 'removeEventListener').mockImplementation(((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === 'message') removed.push(listener);
      EventTarget.prototype.removeEventListener.call(window, type, listener, options);
    }) as typeof window.removeEventListener);

    try {
      const onToolCall = mock(async () => ({ content: [] }));
      const { container, unmount, source } = await mountApp({ onToolCall });
      await handshake(source);
      expect(added.length).toBe(1);
      expect(removed.length).toBe(0);

      unmount();
      await settle();

      expect(container.querySelector('iframe')).toBeNull();
      expect(removed).toEqual(added);
      expect(framePayloads.some((message) => message.method === 'ui/resource-teardown')).toBe(true);

      fromApp(source, { id: 40, method: 'tools/call', params: { name: 'late' } });
      await settle();
      expect(onToolCall).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  test('aborts an in-flight tool call when unmounted', async () => {
    let signal: AbortSignal | undefined;
    const onToolCall = (_params: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise<CallToolResult>(() => {});
    };
    const { unmount, source } = await mountApp({ onToolCall });
    await handshake(source);
    fromApp(source, { id: 50, method: 'tools/call', params: { name: 'slow' } });
    await settle();
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  test('does not leave a listener behind when unmounted before the resource loads', async () => {
    const add = spyOn(window, 'addEventListener');
    let resolveLoad: (resource: McpAppResource) => void = () => {};
    const view = render(McpApp, {
      props: {
        resourceUri: 'ui://slow',
        loadResource: () => new Promise<McpAppResource>((resolve) => (resolveLoad = resolve)),
      },
    });
    view.unmount();
    resolveLoad(RESOURCE);
    await settle();
    expect(add.mock.calls.filter(([type]) => type === 'message')).toHaveLength(0);
    add.mockRestore();
  });
});
