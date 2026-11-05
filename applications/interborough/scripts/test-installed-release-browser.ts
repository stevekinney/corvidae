import { chromium } from '@playwright/test';

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

export async function assertInstalledAppsInChromium(
  installedUrl: string,
  panelUrl: string,
  inspectorUrl: string,
  runId: string,
): Promise<void> {
  const referenceHost = await Bun.build({
    entrypoints: [new URL('../tests/mcp-apps/reference-host.ts', import.meta.url).pathname],
    target: 'browser',
    format: 'esm',
  });
  if (!referenceHost.success)
    throw new AggregateError(referenceHost.logs, 'Reference host failed to build');
  const hostScript = await referenceHost.outputs[0]!.text();
  const browser = await chromium.launch({ headless: true });
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

    const panelResponse = await fetch(panelUrl);
    if (!panelResponse.ok) throw new Error(`Installed panel returned ${panelResponse.status}`);
    const panelPayload = (await panelResponse.json()) as InstalledUi;
    if (!panelPayload.html || !panelPayload.ui?.csp)
      throw new Error('Installed panel omitted UI metadata');
    const inspectorResponse = await fetch(inspectorUrl);
    if (!inspectorResponse.ok)
      throw new Error(`Installed inspector returned ${inspectorResponse.status}`);
    const inspectorPayload = (await inspectorResponse.json()) as InstalledUi;
    const inspectionResponse = await fetch(`${installedUrl}/bureau/mcp`, {
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
    if (!inspectionResponse.ok)
      throw new Error(`Installed inspector tool returned ${inspectionResponse.status}`);
    const inspectionEnvelope = (await inspectionResponse.json()) as {
      result?: unknown;
      error?: unknown;
    };
    if (inspectionEnvelope.error !== undefined || inspectionEnvelope.result === undefined)
      throw new Error('Installed inspector tool returned an error');

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
      async ({ html, csp, inspection, run }) => {
        const host = (window as Window & { referenceHost: BrowserReferenceHost }).referenceHost;
        host.handlers['bureau.tasks.inspect'] = () => inspection;
        return host.mount(html, csp, { taskId: run });
      },
      {
        html: inspectorPayload.html,
        csp: inspectorPayload.ui.csp,
        inspection: inspectionEnvelope.result,
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
