import type { Page, Route } from '@playwright/test';

import { expect, test } from './fixtures.ts';

const RUNNING_VALUE = '.cinder-statistic__value';

type FleetWindow = Window & {
  __emitFleet: (kind: string) => void;
  __fleetReady: boolean;
  __holdFleetReconnect: () => void;
  __releaseFleetReconnect: (kind: string) => void;
  __severFleet: () => void;
};

async function installFleetHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const heldConnections: Array<(response: Response) => void> = [];
    let fleetReady = false;
    let holdConnections = false;
    let sequence = 0;

    function frame(kind: string): Uint8Array {
      sequence += 1;
      const envelope = {
        kind,
        sequence,
        cursor: String(sequence),
        emittedAtMs: Date.now(),
        payload: {},
      };
      return encoder.encode(
        `id: ${String(sequence)}\nevent: ${kind}\ndata: ${JSON.stringify(envelope)}\n\n`,
      );
    }

    function openStream(replayKind?: string): Response {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.add(controller);
          if (replayKind !== undefined) controller.enqueue(frame(replayKind));
          controller.enqueue(encoder.encode('event: ping\ndata: {"replayComplete":true}\n\n'));
          fleetReady = true;
        },
        cancel() {},
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }

    window.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const address =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!new URL(address, location.href).pathname.endsWith('/v1/events/sse')) {
          return originalFetch(input, init);
        }
        if (holdConnections)
          return new Promise<Response>((resolve) => heldConnections.push(resolve));
        return Promise.resolve(openStream());
      },
      { preconnect: window.fetch.preconnect },
    );

    Object.defineProperties(window, {
      __emitFleet: {
        value: (kind: string) => {
          const chunk = frame(kind);
          for (const controller of controllers) controller.enqueue(chunk);
        },
      },
      __fleetReady: { get: () => fleetReady },
      __holdFleetReconnect: { value: () => (holdConnections = true) },
      __releaseFleetReconnect: {
        value: (kind: string) => {
          holdConnections = false;
          for (const resolve of heldConnections.splice(0)) resolve(openStream(kind));
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

async function waitForFleet(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as FleetWindow).__fleetReady))
    .toBe(true);
}

async function holdReconnect(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as FleetWindow).__holdFleetReconnect();
  });
}

async function releaseReconnect(page: Page, kind: string): Promise<void> {
  await page.evaluate((eventKind) => {
    (window as unknown as FleetWindow).__releaseFleetReconnect(eventKind);
  }, kind);
}

async function sever(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as FleetWindow).__severFleet();
  });
}

async function installRunningRoute(
  page: Page,
  getRunningCount: () => number,
  onRunningRequest?: () => void,
): Promise<void> {
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
    onRunningRequest?.();
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
  await Promise.all([waitForFleet(page), waitForFleet(second)]);
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

  let runningRequests = 0;
  await holdReconnect(page);
  await installRunningRoute(
    page,
    () => runningCount,
    () => (runningRequests += 1),
  );
  const requestsBeforeFallback = runningRequests;
  runningCount = 1;
  await sever(page);
  await page.clock.runFor(15_000);
  expect(runningRequests).toBeGreaterThan(requestsBeforeFallback);
  await expect(runningValue(page)).toHaveText('1');

  runningCount = 0;
  await releaseReconnect(page, 'workflow:completed');
  await expect(runningValue(page)).toHaveText('0');
  await second.close();
});
