import { chromium, type Page } from '@playwright/test';

import type { InstalledFetch } from './test-installed-release-transport.ts';

type BrowserPage = {
  on(event: 'pageerror', listener: (error: Error) => void): void;
  goto(url: string): Promise<{ status(): number } | null>;
  locator(selector: string): { waitFor(): Promise<void> };
  waitForFunction(callback: () => boolean): Promise<void>;
  route(
    url: string,
    handler: (route: {
      fulfill(options: { contentType: string; body: string }): Promise<void>;
    }) => Promise<void>,
  ): Promise<void>;
  addScriptTag(options: { content: string; type: string }): Promise<void>;
  exposeFunction(
    name: string,
    callback: (toolArguments: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void>;
  evaluate: Page['evaluate'];
  frameLocator(selector: string): {
    getByText(text: string): { waitFor(): Promise<void> };
    getByRole(role: string, options: { level: number; name: string }): { waitFor(): Promise<void> };
  };
};
type BrowserSession = { newPage(): Promise<BrowserPage>; close(): Promise<void> };
export type InstalledBrowserOperations = {
  readonly build?: (options: Parameters<typeof Bun.build>[0]) => Promise<{
    success: boolean;
    logs: unknown[];
    outputs: { text(): Promise<string> }[];
  }>;
  readonly launch?: (options: { headless: true }) => Promise<BrowserSession>;
  readonly fetch?: InstalledFetch;
};

type BrowserReferenceHost = {
  readonly mount: (
    html: string,
    csp: unknown,
    input: Record<string, unknown>,
    title?: string,
  ) => Promise<void>;
  readonly teardown: () => Promise<void>;
  readonly handlers: Record<string, (toolArguments: Record<string, unknown>) => unknown>;
};

type InstalledUi = { readonly html: string; readonly ui: { readonly csp: unknown } };
type InstalledBrowserWindow = {
  referenceHost: BrowserReferenceHost;
  installedInspectorCall: (toolArguments: Record<string, unknown>) => Promise<unknown>;
};

export function validateInstalledUi(
  response: Response,
  payload: InstalledUi,
  kind: string,
): InstalledUi {
  if (!response.ok) throw new Error(`Installed ${kind} returned ${response.status}`);
  if (!payload.html || !payload.ui?.csp) throw new Error(`Installed ${kind} omitted UI metadata`);
  return payload;
}

export function validateInspection(
  response: Response,
  envelope: { result?: unknown; error?: unknown },
): unknown {
  if (!response.ok) throw new Error(`Installed inspector tool returned ${response.status}`);
  if (envelope.error !== undefined || envelope.result === undefined)
    throw new Error('Installed inspector tool returned an error');
  return envelope.result;
}

export async function assertInstalledAppsInChromium(
  installedUrl: string,
  panelUrl: string,
  inspectorUrl: string,
  runId: string,
  operations: InstalledBrowserOperations = {},
): Promise<void> {
  const build = operations.build ?? Bun.build;
  const launch = operations.launch ?? chromium.launch.bind(chromium);
  const fetcher = operations.fetch ?? fetch;
  const referenceHost = await build({
    entrypoints: [new URL('../tests/mcp-apps/reference-host.ts', import.meta.url).pathname],
    target: 'browser',
    format: 'esm',
  });
  if (!referenceHost.success)
    throw new AggregateError(referenceHost.logs, 'Reference host failed to build');
  const hostScript = await referenceHost.outputs[0]!.text();
  const browser: BrowserSession = await launch({ headless: true });
  const shellErrors: string[] = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => shellErrors.push(error.message));
    const shell = await page.goto(installedUrl);
    if (shell?.status() !== 200) throw new Error(`Installed shell returned ${shell?.status()}`);
    await page.locator('#app').waitFor();
    await page.waitForFunction(() => (document.querySelector('#app')?.children.length ?? 0) > 0);
    if (shellErrors.length > 0)
      throw new Error(`Installed shell JavaScript failed: ${shellErrors.join('; ')}`);

    const panelResponse = await fetcher(panelUrl);
    const panelPayload = validateInstalledUi(
      panelResponse,
      (await panelResponse.json()) as InstalledUi,
      'panel',
    );
    const inspectorResponse = await fetcher(inspectorUrl);
    const inspectorPayload = validateInstalledUi(
      inspectorResponse,
      (await inspectorResponse.json()) as InstalledUi,
      'inspector',
    );
    const inspectionCalls = new Set<string>();
    await page.exposeFunction('installedInspectorCall', async (call) => {
      const name = call['name'];
      if (name !== 'bureau.tasks.inspect' && name !== 'bureau.tasks.events')
        throw new Error('Inspector requested an unsupported tool');
      const toolArguments = call['arguments'] as Record<string, unknown>;
      if (toolArguments['taskId'] !== runId) throw new Error('Inspector requested the wrong task');
      const response = await fetcher(`${inspectorUrl}/tool-calls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, arguments: toolArguments }),
      });
      const result = (await response.json()) as { structuredContent?: unknown; isError?: boolean };
      const inspection = validateInspection(response, {
        result: result.structuredContent,
        ...(result.isError ? { error: result } : {}),
      });
      inspectionCalls.add(name);
      return inspection;
    });

    await page.route('http://reference-host.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Reference host</title>',
      }),
    );
    await page.goto('http://reference-host.test/');
    await page.addScriptTag({ content: hostScript, type: 'module' });
    await page.evaluate(
      async ({ html, csp }) =>
        (window as unknown as InstalledBrowserWindow).referenceHost.mount(
          html,
          csp,
          {},
          'Fixture panel',
        ),
      { html: panelPayload.html, csp: panelPayload.ui.csp },
    );
    await page
      .frameLocator('iframe[title="Fixture panel"]')
      .getByText('Installed fixture MCP panel')
      .waitFor();
    await page.evaluate(() =>
      (window as unknown as InstalledBrowserWindow).referenceHost.teardown(),
    );
    await page.evaluate(
      async ({ html, csp, run }) => {
        const browserWindow = window as unknown as InstalledBrowserWindow;
        const host = browserWindow.referenceHost;
        for (const name of ['bureau.tasks.inspect', 'bureau.tasks.events']) {
          host.handlers[name] = (toolArguments) =>
            browserWindow.installedInspectorCall({ name, arguments: toolArguments });
        }
        return host.mount(html, csp, { taskId: run });
      },
      {
        html: inspectorPayload.html,
        csp: inspectorPayload.ui.csp,
        run: runId,
      },
    );
    await page
      .frameLocator('iframe[title="Run inspector"]')
      .getByRole('heading', { level: 1, name: `Run ${runId}` })
      .waitFor();
    if (inspectionCalls.size !== 2)
      throw new Error('Inspector did not call the installed tool route');
    await page.evaluate(() =>
      (window as unknown as InstalledBrowserWindow).referenceHost.teardown(),
    );
  } finally {
    await browser.close();
  }
}
