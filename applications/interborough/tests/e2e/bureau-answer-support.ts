/**
 * Rewrites what the Bureau answers the page, for a spec that needs a state the sample world does
 * not show on its own: the real Bureau answers, and the spec changes the result before the page
 * reads it.
 *
 * The page's Bureau calls go through the generated client, which posts every one to the host's
 * composed `/jsonrpc` endpoint (`src/lib/bureau-transport.ts`), never to `/bureau/jsonrpc`; a route
 * on the old path matches nothing, and the page then shows the unrewritten world.
 * `tests/bureau-answer-support.test.ts` holds this to the URL the transport actually requests.
 */
import type { Page, Route } from '@playwright/test';

type JsonRecord = Record<string, unknown>;

/** Whether `url` is the endpoint the page's Bureau calls are posted to. */
export function isBureauCall(url: URL): boolean {
  return url.pathname === '/jsonrpc';
}

/**
 * Answers the Bureau operation `method` with its own answer's result rewritten by `rewrite`; every
 * other call goes on to the routes registered before this one, and then to the host.
 */
export async function rewriteBureauAnswer(
  page: Page,
  method: string,
  rewrite: (result: JsonRecord) => JsonRecord,
): Promise<void> {
  await page.route(isBureauCall, async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { method?: string };
    if (body.method !== method) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const answer = (await response.json()) as { result?: JsonRecord };
    await route.fulfill({ response, json: { ...answer, result: rewrite(answer.result ?? {}) } });
  });
}
