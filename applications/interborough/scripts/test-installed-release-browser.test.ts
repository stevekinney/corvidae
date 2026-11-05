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
  } = {},
) {
  const calls: string[] = [];
  let closed = false;
  const host = {
    handlers: {} as Record<string, unknown>,
    async mount() {
      calls.push('mount');
      const inspect = this.handlers['bureau.tasks.inspect'] as (() => unknown) | undefined;
      inspect?.();
    },
    async teardown() {
      calls.push('teardown');
    },
  };
  (globalThis as any).window = { referenceHost: host };
  (globalThis as any).document = { querySelector: () => ({ children: [{}] }) };
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
    evaluate: async (callback: (value: any) => Promise<unknown>, value: any) => callback(value),
    frameLocator: (selector: string) => ({
      getByText: () => ({
        count: async () => (selector.includes('Fixture') ? (options.panelCount ?? 1) : 0),
      }),
      getByRole: () => ({ count: async () => options.headingCount ?? 1 }),
    }),
  };
  const browser = {
    newPage: async () => page,
    close: async () => {
      closed = true;
      calls.push('close');
    },
  };
  const fetcher = async (input: string | URL | Request) => {
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
    return new Response(JSON.stringify(options.inspection ?? { result: { taskId: 'run-1' } }));
  };
  const configured: InstalledBrowserOperations = {
    build:
      options.build ??
      (async () => ({ success: true, outputs: [{ text: async () => 'host-script' }] })),
    launch: async () => browser,
    fetch: fetcher,
  };
  return { configured, calls, closed };
}

test('runs every browser orchestration callback through deterministic ports', async () => {
  const setup = operations();
  await assertInstalledAppsInChromium(
    'http://installed/',
    'http://installed/panel',
    'http://installed/inspector',
    'run-1',
    setup.configured,
  );
  expect(setup.calls).toContain('mount');
  expect(setup.calls).toContain('teardown');
  expect(setup.calls).toContain('close');
});

test('closes the browser for each finite browser failure', async () => {
  const buildFailure = operations({ build: async () => ({ success: false, logs: [] }) });
  await expect(
    assertInstalledAppsInChromium(
      'http://installed/',
      'http://installed/panel',
      'http://installed/inspector',
      'run-1',
      buildFailure.configured,
    ),
  ).rejects.toThrow();
  expect(buildFailure.calls).not.toContain('close');
  const cases = [
    operations({ shellStatus: 500 }),
    operations({ pageError: new Error('script failed') }),
    operations({ panel: { html: '', ui: { csp: {} } } }),
    operations({ inspector: { html: '', ui: { csp: {} } } }),
    operations({ inspection: { error: { message: 'bad' } } }),
    operations({ panelCount: 0 }),
    operations({ headingCount: 0 }),
  ];
  for (const setup of cases) {
    await expect(
      assertInstalledAppsInChromium(
        'http://installed/',
        'http://installed/panel',
        'http://installed/inspector',
        'run-1',
        setup.configured,
      ),
    ).rejects.toThrow();
    expect(setup.calls).toContain('close');
  }
});
