/**
 * A diagnostic for the journey's chat reply (COR-2412). It failed once in CI with the run started
 * and no assistant row for 120 seconds, and the trace was gone. This records the page's traffic to
 * the Bureau and, when the reply expectation fails, the server's side, so the next failure says
 * whether the server never replied or the page lost the reply. It changes nothing the test asserts.
 */
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';

import { E2E_JOURNEY_URL } from './e2e-constants.ts';

const WATCHED = ['/bureau/ag-ui/', '/bureau/jsonrpc'];

/** Starts recording; `stop` ends it and `lines` is what was seen. */
export function recordBureauTraffic(page: Page): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const started = Date.now();
  const at = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`;
  const watched = (url: string) => WATCHED.some((part) => url.includes(part));
  const label = (url: string) => new URL(url).pathname;
  const onRequest = (request: import('@playwright/test').Request) => {
    if (watched(request.url())) lines.push(`${at()} > ${request.method()} ${label(request.url())}`);
  };
  const onResponse = (response: import('@playwright/test').Response) => {
    const request = response.request();
    if (!watched(response.url())) return;
    const stream = (response.headers()['content-type'] ?? '').includes('text/event-stream');
    lines.push(
      `${at()} < ${response.status()} ${request.method()} ${label(response.url())}${stream ? ' (event stream opened)' : ''}`,
    );
  };
  const onFinished = (request: import('@playwright/test').Request) => {
    if (watched(request.url())) lines.push(`${at()} = finished ${label(request.url())}`);
  };
  const onFailed = (request: import('@playwright/test').Request) => {
    if (watched(request.url())) {
      lines.push(
        `${at()} ! failed ${label(request.url())}: ${request.failure()?.errorText ?? 'unknown'}`,
      );
    }
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  return {
    lines,
    stop: () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
    },
  };
}

/** The server's record of a session, read through the journey host; a failed read is reported. */
async function serverSide(request: APIRequestContext, sessionId: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const response = await request.get(
      `${E2E_JOURNEY_URL}/bureau/ag-ui/threads/${encodeURIComponent(sessionId)}/messages`,
    );
    const { messages } = (await response.json()) as {
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    out.push(`server thread messages (${response.status()}): ${messages?.length ?? 0}`);
    for (const message of (messages ?? []).slice(-6)) {
      out.push(`  ${message.role}: ${JSON.stringify(message.content ?? null).slice(0, 120)}`);
    }
  } catch (error) {
    out.push(`server thread messages unreadable: ${String(error)}`);
  }
  try {
    const response = await request.post(`${E2E_JOURNEY_URL}/bureau/jsonrpc`, {
      data: {
        jsonrpc: '2.0',
        id: 'bureau.tasks.list',
        method: 'bureau.tasks.list',
        params: { contextId: sessionId },
      },
    });
    const body = (await response.json()) as {
      result?: { tasks?: Array<{ id: string; status: string }> };
    };
    const tasks = body.result?.tasks ?? [];
    out.push(`server tasks (${response.status()}): ${tasks.length}`);
    for (const task of tasks.slice(0, 5)) out.push(`  ${task.id}: ${task.status}`);
  } catch (error) {
    out.push(`server tasks unreadable: ${String(error)}`);
  }
  return out;
}

/**
 * Runs the reply expectation. On failure it prints and attaches a summary of the page's traffic and
 * the server's record, then rethrows the original error.
 */
export async function withReplyDiagnostics(
  traffic: ReturnType<typeof recordBureauTraffic>,
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  sessionOf: () => string,
  expectReply: () => Promise<void>,
): Promise<void> {
  try {
    await expectReply();
  } catch (error) {
    const sessionId = sessionOf();
    const summary = [
      `COR-2412 reply diagnostic for session ${sessionId}`,
      `page address: ${new URL(page.url()).pathname}`,
      `Bureau traffic seen by the page (${traffic.lines.length}, last 20):`,
      ...traffic.lines.slice(-20).map((line) => `  ${line}`),
      ...(await serverSide(request, sessionId)),
    ].slice(0, 39);
    const text = summary.join('\n');
    console.log(text);
    await testInfo.attach('reply-diagnostic', { body: text, contentType: 'text/plain' });
    throw error;
  } finally {
    traffic.stop();
  }
}
