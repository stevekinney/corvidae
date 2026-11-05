import { chromium } from '@playwright/test';

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
  evaluate<T>(callback: (value: any) => Promise<T>, value?: any): Promise<T>;
  frameLocator(selector: string): {
    getByText(text: string): { count(): Promise<number> };
    getByRole(role: string, options: { level: number; name: string }): { count(): Promise<number> };
  };
};
type BrowserSession = { newPage(): Promise<BrowserPage>; close(): Promise<void> };
export type InstalledBrowserOperations = {
  readonly build?: (options: Parameters<typeof Bun.build>[0]) => Promise<any>;
  readonly launch?: (options: { headless: true }) => Promise<BrowserSession>;
  readonly fetch?: typeof fetch;
};

type BrowserReferenceHost = {
  readonly mount: (
    html: string,
    csp: unknown,
    input: Record<string, unknown>,
    title?: string,
  ) => Promise<void>;
  readonly teardown: () => Promise<void>;
  readonly handlers: Record<string, (arguments_: Record<string, unknown>) => unknown>;
};

type InstalledUi = { readonly html: string; readonly ui: { readonly csp: unknown } };

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
  const browser = await launch({ headless: true });
  const shellErrors: string[] = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => shellErrors.push(error.message));
    const shell = await page.goto(installedUrl);
    if (shell?.status() !== 200) throw new Error(`Installed shell returned ${shell?.status()}`);
    await page.locator('#app').waitFor();
    await page.waitForFunction(() => document.querySelector('#app')?.children.length !== 0);
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
    const inspectionResponse = await fetcher(`${installedUrl}/bureau/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-03-26',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: { name: 'bureau.tasks.inspect', arguments: { taskId: runId } },
      }),
    });
    const inspectionEnvelope = (await inspectionResponse.json()) as {
      result?: unknown;
      error?: unknown;
    };
    const inspection = validateInspection(inspectionResponse, inspectionEnvelope);

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
        (window as Window & { referenceHost: BrowserReferenceHost }).referenceHost.mount(
          html,
          csp,
          {},
          'Fixture panel',
        ),
      { html: panelPayload.html, csp: panelPayload.ui.csp },
    );
    if (
      !(await page
        .frameLocator('iframe[title="Fixture panel"]')
        .getByText('Installed fixture MCP panel')
        .count())
    )
      throw new Error('Chromium did not render fixture panel through AppBridge');
    await page.evaluate(() =>
      (window as Window & { referenceHost: BrowserReferenceHost }).referenceHost.teardown(),
    );
    await page.evaluate(
      async ({ html, csp, inspection: inspectionValue, run }) => {
        const host = (window as Window & { referenceHost: BrowserReferenceHost }).referenceHost;
        host.handlers['bureau.tasks.inspect'] = () => inspectionValue;
        return host.mount(html, csp, { taskId: run });
      },
      {
        html: inspectorPayload.html,
        csp: inspectorPayload.ui.csp,
        inspection,
        run: runId,
      },
    );
    if (
      !(await page
        .frameLocator('iframe[title="Run inspector"]')
        .getByRole('heading', { level: 1, name: `Run ${runId}` })
        .count())
    )
      throw new Error(`Chromium did not mount inspector through AppBridge for ${runId}`);
    await page.evaluate(() =>
      (window as Window & { referenceHost: BrowserReferenceHost }).referenceHost.teardown(),
    );
  } finally {
    await browser.close();
  }
}
