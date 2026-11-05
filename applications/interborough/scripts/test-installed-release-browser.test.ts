import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { expect, test } from 'bun:test';

import {
  assertInstalledAppsInChromium,
  type InstalledBrowserOperations,
} from './test-installed-release-browser.ts';

function operations(
  options: {
    readonly build?: any;
    readonly shellStatus?: number;
    readonly panel?: any;
    readonly inspector?: any;
    readonly inspection?: any;
    readonly panelCount?: number;
    readonly headingCount?: number;
    readonly pageError?: Error;
    readonly wrongTask?: boolean;
    readonly skipTool?: boolean;
    readonly unsupportedTool?: boolean;
  } = {},
) {
  const calls: string[] = [];
  let closed = false;
  const host = {
    handlers: {} as Record<string, unknown>,
    async mount(_html: string, _csp: unknown, input: Record<string, unknown>) {
      calls.push('mount');
      const inspect = this.handlers['bureau.tasks.inspect'] as
        ((args: unknown) => unknown) | undefined;
      if (!options.skipTool) {
        await inspect?.({ taskId: options.wrongTask ? 'wrong' : input['taskId'] });
        const events = this.handlers['bureau.tasks.events'] as
          ((args: unknown) => unknown) | undefined;
        await events?.({ taskId: input['taskId'] });
      }
      if (options.unsupportedTool)
        await browserWindow.installedInspectorCall({ name: 'unknown', arguments: {} });
    },
    async teardown() {
      calls.push('teardown');
    },
  };
  const browserWindow: any = { referenceHost: host };
  const page: any = {
    on: (_event: string, listener: (error: Error) => void) => {
      if (options.pageError) listener(options.pageError);
    },
    goto: async (url: string) => {
      calls.push(`goto:${url}`);
      return { status: () => options.shellStatus ?? 200 };
    },
    locator: () => ({ waitFor: async () => undefined }),
    waitForFunction: async (callback: () => boolean) => {
      callback();
    },
    route: async (_url: string, handler: (route: any) => Promise<void>) => {
      await handler({
        fulfill: async () => {
          calls.push('route');
        },
      });
    },
    addScriptTag: async () => {
      calls.push('script');
    },
    exposeFunction: async (name: string, callback: unknown) => {
      browserWindow[name] = callback;
    },
    evaluate: async (callback: (value: any) => Promise<unknown>, value: any) => callback(value),
    frameLocator: (selector: string) => ({
      getByText: () => ({
        waitFor: async () => {
          if (!selector.includes('Fixture') || options.panelCount === 0)
            throw new Error('Panel absent');
        },
      }),
      getByRole: () => ({
        waitFor: async () => {
          if (options.headingCount === 0) throw new Error('Heading absent');
        },
      }),
    }),
  };
  const browser = {
    newPage: async () => page,
    close: async () => {
      closed = true;
      calls.push('close');
    },
  };
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/panel'))
      return new Response(
        JSON.stringify(
          options.panel ?? { html: '<main>Installed fixture MCP panel</main>', ui: { csp: {} } },
        ),
      );
    if (url.endsWith('/inspector'))
      return new Response(
        JSON.stringify(options.inspector ?? { html: '<div id="root"></div>', ui: { csp: {} } }),
      );
    expect(url).toBe('http://installed/inspector/tool-calls');
    expect(init?.method).toBe('POST');
    const request = JSON.parse(init?.body as string);
    expect(['bureau.tasks.inspect', 'bureau.tasks.events']).toContain(request.name);
    expect(request).toEqual({
      name: request.name,
      arguments: { taskId: 'run-1' },
    });
    calls.push(`installed-tool-call:${request.name}`);
    return new Response(
      JSON.stringify(options.inspection ?? { structuredContent: { taskId: 'run-1' } }),
    );
  };
  const configured: InstalledBrowserOperations = {
    build:
      options.build ??
      (async () => ({ success: true, logs: [], outputs: [{ text: async () => 'host-script' }] })),
    launch: async () => browser,
    fetch: fetcher,
  };
  const run = async () => {
    const descriptors = ['window', 'document'].map(
      (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    );
    Object.defineProperty(globalThis, 'window', { configurable: true, value: browserWindow });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { querySelector: () => ({ children: [{}] }) },
    });
    try {
      await assertInstalledAppsInChromium(
        'http://installed/',
        'http://installed/panel',
        'http://installed/inspector',
        'run-1',
        configured,
      );
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  };
  return { configured, calls, closed, run };
}

test('runs every browser orchestration callback through deterministic ports', async () => {
  const setup = operations();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  await setup.run();
  expect(Object.getOwnPropertyDescriptor(globalThis, 'window')).toEqual(previousWindow);
  expect(setup.calls).toContain('installed-tool-call:bureau.tasks.inspect');
  expect(setup.calls).toContain('installed-tool-call:bureau.tasks.events');
  expect(setup.calls).toContain('mount');
  expect(setup.calls).toContain('teardown');
  expect(setup.calls).toContain('close');
});

test('closes the browser for each finite browser failure', async () => {
  const buildFailure = operations({ build: async () => ({ success: false, logs: [] }) });
  expect(await throwingRejectionOf(buildFailure.run())).toThrow();
  expect(buildFailure.calls).not.toContain('close');
  const cases = [
    operations({ shellStatus: 500 }),
    operations({ pageError: new Error('script failed') }),
    operations({ panel: { html: '', ui: { csp: {} } } }),
    operations({ inspector: { html: '', ui: { csp: {} } } }),
    operations({ inspection: { isError: true, structuredContent: {} } }),
    operations({ inspection: {} }),
    operations({ wrongTask: true }),
    operations({ unsupportedTool: true }),
    operations({ skipTool: true }),
    operations({ panelCount: 0 }),
    operations({ headingCount: 0 }),
  ];
  for (const setup of cases) {
    expect(await throwingRejectionOf(setup.run())).toThrow();
    expect(setup.calls).toContain('close');
  }
});
