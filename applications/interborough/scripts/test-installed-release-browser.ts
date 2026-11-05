import { chromium } from '@playwright/test';

import { MCP_APP_UI_META } from '../src/host/mcp-app-mounts.ts';

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

export async function assertInstalledAppsInChromium(
  url: string,
  panelHtml: string,
  inspectorHtml: string,
  runId: string,
  inspection: unknown,
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
  try {
    const page = await browser.newPage();
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
      { html: panelHtml, csp: MCP_APP_UI_META.csp },
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
      async ({ html, csp, inspected }) => {
        const host = (window as Window & { referenceHost: BrowserReferenceHost }).referenceHost;
        host.handlers['bureau.tasks.inspect'] = () => inspected;
        return host.mount(html, csp, {
          taskId:
            inspected && typeof inspected === 'object' && 'taskId' in inspected
              ? String(inspected.taskId)
              : '',
        });
      },
      { html: inspectorHtml, csp: MCP_APP_UI_META.csp, inspected: inspection },
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
