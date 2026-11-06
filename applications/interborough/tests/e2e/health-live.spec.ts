import type { Page, Route } from '@playwright/test';

import { expect, test } from './fixtures.ts';

const RUNNING_VALUE = '.cinder-statistic__value';

type FleetWindow = Window & {
  __emitFleet: (kind: string) => void;
  __severFleet: () => void;
};

async function installFleetHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
    let sequence = 0;

    window.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const address =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!new URL(address, location.href).pathname.endsWith('/v1/events/sse')) {
          return originalFetch(input, init);
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.add(controller);
            controller.enqueue(encoder.encode('event: ping\ndata: {"replayComplete":true}\n\n'));
            init?.signal?.addEventListener('abort', () => {
              controllers.delete(controller);
              try {
                controller.close();
              } catch {
                // The source may already have closed this stream.
              }
            });
          },
          cancel() {},
        });
        return Promise.resolve(
          new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
        );
      },
      { preconnect: window.fetch.preconnect },
    );

    Object.defineProperties(window, {
      __emitFleet: {
        value: (kind: string) => {
          sequence += 1;
          const envelope = {
            kind,
            sequence,
            cursor: String(sequence),
            emittedAtMs: Date.now(),
            payload: {},
          };
          const chunk = encoder.encode(
            `id: ${String(sequence)}\nevent: ${kind}\ndata: ${JSON.stringify(envelope)}\n\n`,
          );
          for (const controller of controllers) controller.enqueue(chunk);
        },
      },
      __severFleet: {
        value: () => {
          for (const controller of controllers) {
            controllers.delete(controller);
            controller.error(new TypeError('test fleet transport cut'));
          }
        },
      },
    });
  });
}

function runningValue(page: Page) {
  return page.getByRole('group', { name: 'Health counts' }).locator(RUNNING_VALUE).first();
}

async function emit(page: Page, kind: string): Promise<void> {
  await page.evaluate((eventKind) => {
    (window as unknown as FleetWindow).__emitFleet(eventKind);
  }, kind);
}

async function sever(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as FleetWindow).__severFleet();
  });
}

async function installRunningRoute(page: Page, getRunningCount: () => number): Promise<void> {
  await page.route('**/jsonrpc', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      id?: unknown;
      method?: string;
      params?: { status?: string };
    };
    if (body.method !== 'weft.workflows.list' || body.params?.status !== 'running') {
      await route.fallback();
      return;
    }
    const runningCount = getRunningCount();
    await route.fulfill({
      json: {
        jsonrpc: '2.0',
        id: body.id ?? 1,
        result: {
          items: Array.from({ length: runningCount }, (_, index) => ({
            id: `live-run-${String(index)}`,
            status: 'running',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })),
          total: runningCount,
        },
      },
    });
  });
}

test('Health running workflows update from the fleet feed', async ({ context, page }) => {
  let runningCount = 0;
  await page.clock.install();
  await installFleetHarness(page);
  await installRunningRoute(page, () => runningCount);

  const second = await context.newPage();
  await second.clock.install();
  await installFleetHarness(second);
  await installRunningRoute(second, () => runningCount);

  await Promise.all([page.goto('/health'), second.goto('/health')]);
  await Promise.all([
    expect(runningValue(page)).toHaveText('0'),
    expect(runningValue(second)).toHaveText('0'),
  ]);

  runningCount = 1;
  await Promise.all([emit(page, 'workflow:started'), emit(second, 'workflow:started')]);
  await Promise.all([
    expect(runningValue(page)).toHaveText('1'),
    expect(runningValue(second)).toHaveText('1'),
  ]);

  runningCount = 0;
  await Promise.all([emit(page, 'workflow:completed'), emit(second, 'workflow:completed')]);
  await Promise.all([
    expect(runningValue(page)).toHaveText('0'),
    expect(runningValue(second)).toHaveText('0'),
  ]);

  runningCount = 1;
  await sever(page);
  await page.clock.runFor(15_000);
  await expect(runningValue(page)).toHaveText('1');

  runningCount = 0;
  await emit(page, 'workflow:completed');
  await expect(runningValue(page)).toHaveText('0');
  await second.close();
});
