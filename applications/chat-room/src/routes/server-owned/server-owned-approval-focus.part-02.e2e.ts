import type { Request } from '@playwright/test';
import { expect, test } from '@playwright/test';
import type { PostOutcome, Route } from './server-owned-approval-focus-test-helpers';
import {
  assertApprovedPost,
  fixtureMarker,
  gotoHydrated,
  newFixtureMarker,
  uniqueTitle,
} from './server-owned-approval-focus-test-helpers';

const POST_OUTCOMES = [
  'success',
  'conflict',
  'error',
  'network',
  'completed-success',
  'completed-error',
] as const satisfies readonly PostOutcome[];

function isElicitationPostRequest(request: Request): boolean {
  return request.method() === 'POST' && request.url().includes('/elicitation');
}

type RemoteState = 'server' | 'removed' | 'replaced';

async function fulfillRemotePending(route: Route, remoteState: RemoteState): Promise<boolean> {
  if (remoteState === 'removed') {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"pending":null}',
    });
    return true;
  }
  if (remoteState === 'replaced') {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        pending: {
          toolName: 'remember_note',
          callId: 'remote-replacement',
          message: 'Save the replacement note?',
          arguments: { text: 'replacement' },
        },
      }),
    });
    return true;
  }
  return false;
}

async function fulfillCompletedPost(route: Route, postOutcome: PostOutcome): Promise<void> {
  await route.fulfill({
    status: postOutcome === 'completed-error' ? 500 : 200,
    contentType: 'application/json',
    body:
      postOutcome === 'completed-error' ? JSON.stringify({ error: 'stale approval failed' }) : '{}',
  });
}

async function fulfillResolvedPost(route: Route, postOutcome: PostOutcome): Promise<void> {
  await route.fulfill({
    status: postOutcome === 'conflict' ? 409 : postOutcome === 'error' ? 500 : 200,
    contentType: 'application/json',
    body: postOutcome === 'error' ? JSON.stringify({ error: 'stale approval failed' }) : '{}',
  });
}

test('stale approval POST outcomes cannot mutate a removed or replaced question', async ({
  page,
}) => {
  await gotoHydrated(page, '/server-owned');
  const title = uniqueTitle('Stale approval outcome');
  await page.locator('[data-testid="server-owned-new-title"]').fill(title);
  await page.locator('[data-testid="server-owned-create"]').click();
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.waitForSelector('body[data-hydrated="true"]');
  await page.getByRole('textbox').fill(fixtureMarker('approval', newFixtureMarker()));
  await page.getByRole('textbox').press('Enter');

  const question = page.locator('[data-testid="approval-question"]');
  const approve = page.locator('[data-testid="approval-approve"]');
  const failure = page.locator('[data-testid="server-owned-turn-failure"]');
  await expect(approve).toBeVisible();

  let remoteState: RemoteState = 'server';
  let releasePost!: () => void;
  let postReady = false;
  let postOutcome: PostOutcome = 'success';
  await page.evaluate(() => {
    const nativeFetch = window.fetch.bind(window);
    type PostGate = { mode: 'fetch' | 'body' | null; ready: boolean; release?: () => void };
    const gate: PostGate = { mode: null, ready: false };
    Object.assign(window, { __approvalPostGate: gate });
    const hold = async (): Promise<void> => {
      gate.ready = true;
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    };
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await nativeFetch(input, init);
        const url = input instanceof Request ? input.url : String(input);
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (
          gate.mode === null ||
          method !== 'POST' ||
          !url.includes('/api/server-owned/conversations/') ||
          !url.endsWith('/elicitation')
        )
          return response;
        // Consume the network body before the question changes: aborting the
        // request can no longer cancel this already-completed response.
        const body = await response.text();
        const completed = new Response(body, {
          status: response.status,
          headers: response.headers,
        });
        if (gate.mode === 'body') {
          // Return headers now, so decide passes its first freshness check.
          // Pause the body only when failureMessage actually reads it.
          Object.defineProperty(completed, 'text', {
            value: async () => {
              await hold();
              return body;
            },
          });
        } else {
          await hold();
        }
        return completed;
      },
    });
  });
  await page.route('**/api/server-owned/conversations/*/elicitation', async (route) => {
    if (route.request().method() === 'GET') {
      if (await fulfillRemotePending(route, remoteState)) return;
      await route.continue();
      return;
    }

    assertApprovedPost(route);
    if (postOutcome.startsWith('completed-')) {
      await fulfillCompletedPost(route, postOutcome);
      postReady = true;
      return;
    }
    await new Promise<void>((resolve) => {
      releasePost = resolve;
      postReady = true;
    });
    if (postOutcome === 'network') await route.abort('failed');
    else await fulfillResolvedPost(route, postOutcome);
  });

  for (const [index, currentOutcome] of POST_OUTCOMES.entries()) {
    postOutcome = currentOutcome;
    postReady = false;
    await page.evaluate(
      (mode) => {
        const gate = Reflect.get(window, '__approvalPostGate');
        if (typeof gate !== 'object' || gate === null) {
          throw new Error('Expected approval POST gate to be installed.');
        }
        Reflect.set(gate, 'mode', mode);
        Reflect.set(gate, 'ready', false);
        Reflect.deleteProperty(gate, 'release');
      },
      currentOutcome === 'completed-error'
        ? 'body'
        : currentOutcome === 'completed-success'
          ? 'fetch'
          : null,
    );
    const postSettled = new Promise<'finished' | 'failed'>((resolve) => {
      const finish = (kind: 'finished' | 'failed') => {
        return (request: Request) => {
          if (!isElicitationPostRequest(request)) return;
          page.off('requestfinished', onFinished);
          page.off('requestfailed', onFailed);
          resolve(kind);
        };
      };
      const onFinished = finish('finished');
      const onFailed = finish('failed');
      page.on('requestfinished', onFinished);
      page.on('requestfailed', onFailed);
    });
    await approve.focus();
    await approve.press('Enter');
    if (currentOutcome.startsWith('completed-')) {
      await expect
        .poll(() =>
          page.evaluate(() => {
            const gate = Reflect.get(window, '__approvalPostGate');
            if (typeof gate !== 'object' || gate === null) return false;
            return Reflect.get(gate, 'ready') === true;
          }),
        )
        .toBe(true);
    } else {
      await expect.poll(() => postReady).toBe(true);
    }
    remoteState =
      currentOutcome.startsWith('completed-') || index % 2 !== 0 ? 'replaced' : 'removed';
    if (remoteState === 'removed') {
      await expect(approve).toHaveCount(0);
    } else {
      await expect(question).toContainText('replacement note');
    }
    postReady = false;
    // Abort cases and completed continuations exercise different boundaries.
    if (currentOutcome.startsWith('completed-')) {
      const afterContinuation = await page.evaluate(async () => {
        const gate = Reflect.get(window, '__approvalPostGate');
        if (typeof gate !== 'object' || gate === null) {
          throw new Error('Expected approval POST gate to be installed.');
        }
        const release = Reflect.get(gate, 'release');
        if (typeof release !== 'function') {
          throw new Error('Expected approval POST gate release to be installed.');
        }
        release();
        // Let the released promise, decide continuation, and Svelte update
        // drain before asserting the absence of a stale mutation.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return {
          question: document.querySelector('[data-testid="approval-question"]')?.textContent,
          failure: document
            .querySelector('[data-testid="server-owned-turn-failure"]')
            ?.textContent?.trim(),
          approveCount: document.querySelectorAll('[data-testid="approval-approve"]').length,
        };
      });
      expect(afterContinuation.question).toContain('replacement note');
      expect(afterContinuation.failure).toBe('');
      expect(afterContinuation.approveCount).toBe(1);

      expect(await postSettled).toBe('finished');
    } else {
      releasePost();
      expect(await postSettled).toBe('failed');
    }
    await expect(failure).toBeEmpty();
    if (remoteState === 'removed') {
      await expect(approve).toHaveCount(0);
      await expect(question).toBeEmpty();
    } else {
      await expect(question).toContainText('replacement note');
      await expect(approve).toBeEnabled();
    }
    remoteState = 'server';
    await expect(question).toContainText('Save this note?');
    await expect(approve).toBeVisible();
  }
});
