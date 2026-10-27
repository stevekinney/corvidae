import type { Page } from '@playwright/test';

import { expectWaiting, newThreadId, releaseBarrier, startRun } from './chat-support.ts';
import { expect, test } from './fixtures.ts';

async function makeInspectable(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const severs = new Set<() => void>();
    let attachRequests = 0;
    let lastCursor: string | undefined;
    let forceSnapshot = false;
    const fetchWithProbe = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      if (forceSnapshot && headers.has('Last-Event-ID'))
        headers.set('Last-Event-ID', 'agui-live-v1.invalid');
      const response = await originalFetch(input, { ...init, headers });
      if (
        !url.includes('/bureau/ag-ui/threads/') ||
        !url.endsWith('/run') ||
        response.body === null
      )
        return response;
      attachRequests += 1;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          severs.add(() => controller.error(new TypeError('network error')));
          void (async () => {
            try {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) {
                  controller.close();
                  return;
                }
                const text = decoder.decode(chunk.value, { stream: true });
                pending += text;
                for (const block of pending.split('\\n\\n').slice(0, -1)) {
                  const id = block.split('\\n').find((line) => line.startsWith('id:'));
                  if (id !== undefined) lastCursor = id.slice(3).trim();
                }
                pending = pending.slice(pending.lastIndexOf('\\n\\n') + 2);
                controller.enqueue(chunk.value);
              }
            } catch (error) {
              try {
                controller.error(error);
              } catch {
                /* stream already ended */
              }
            }
          })();
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return new Response(body, { status: response.status, headers: response.headers });
    };
    window.fetch = Object.assign(fetchWithProbe, { preconnect: window.fetch.preconnect });
    Object.defineProperties(window, {
      __severChatStreams: { value: () => [...severs].forEach((sever) => sever()) },
      __chatAttachRequests: { get: () => attachRequests },
      __lastLiveCursor: { get: () => lastCursor },
      __forceSnapshot: { set: (value: boolean) => (forceSnapshot = value) },
    });
  });
}

async function attachRequests(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __chatAttachRequests: number }).__chatAttachRequests,
  );
}

async function lastCursor(page: Page): Promise<string | undefined> {
  return page.evaluate(() => (window as unknown as { __lastLiveCursor?: string }).__lastLiveCursor);
}

test('recovers a host-preserving drop from the real emitted cursor exactly once', async ({
  page,
  context,
  request,
}) => {
  const threadId = newThreadId('cor-1728-live');
  const run = await startRun('barrier', threadId, 'Start the work');
  try {
    await expectWaiting(request, 1);
    await makeInspectable(page);
    await page.goto(`/chat/${threadId}`);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect.poll(() => attachRequests(page)).toBe(1);
    await expect.poll(() => lastCursor(page)).toMatch(/^agui-live-v1\./);
    await releaseBarrier(request);
    await context.setOffline(true);
    await page.evaluate(() =>
      (window as unknown as { __severChatStreams: () => void }).__severChatStreams(),
    );
    await context.setOffline(false);
    await expect.poll(() => attachRequests(page)).toBeGreaterThan(1);
    await expect(page.getByText('The barrier opened.')).toHaveCount(1);
  } finally {
    await releaseBarrier(request);
    run.abort();
  }
});

test('reconnects with an invalid cursor through the authoritative snapshot exactly once', async ({
  page,
  context,
  request,
}) => {
  const threadId = newThreadId('cor-1728-snapshot');
  const run = await startRun('barrier', threadId, 'Start the work');
  try {
    await expectWaiting(request, 1);
    await makeInspectable(page);
    await page.goto(`/chat/${threadId}`);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect.poll(() => attachRequests(page)).toBe(1);
    await releaseBarrier(request);
    await expect.poll(() => lastCursor(page)).toMatch(/^agui-live-v1\./);
    await page.evaluate(
      () => ((window as unknown as { __forceSnapshot: boolean }).__forceSnapshot = true),
    );
    await context.setOffline(true);
    await page.evaluate(() =>
      (window as unknown as { __severChatStreams: () => void }).__severChatStreams(),
    );
    await context.setOffline(false);
    await expect.poll(() => attachRequests(page)).toBeGreaterThan(1);
    await expect(page.getByText('The barrier opened.')).toHaveCount(1);
  } finally {
    await releaseBarrier(request);
    run.abort();
  }
});
