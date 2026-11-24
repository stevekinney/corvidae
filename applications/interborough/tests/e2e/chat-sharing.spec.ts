/** Real two-member chat sharing: one host, one durable store, and two distinct trusted credentials. */
import type { Browser, BrowserContext, Page } from '@playwright/test';

import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_CHAT_SHARING_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const SOURCE = 'chat-sharing.spec.ts';
const OWNER_KEY = 'chat-owner-browser-key';
const READER_KEY = 'chat-reader-browser-key';
// Neither value is the browser credential subject or the trusted workspace actor ID.
const READER_OWNER = 'chat-sharing:reader';

async function member(browser: Browser, key: string): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: E2E_CHAT_SHARING_URL,
    extraHTTPHeaders: { 'x-api-key': key },
    reducedMotion: 'reduce',
  });
}

async function share(owner: Page, decision: 'grant' | 'revoke'): Promise<void> {
  await owner.getByRole('button', { name: 'More actions' }).click();
  await owner.getByRole('menuitem', { name: 'Share chat' }).click();
  await owner.getByLabel('Workspace member').fill(READER_OWNER);
  await owner
    .getByRole('button', { name: decision === 'grant' ? 'Share read-only' : 'Revoke access' })
    .click();
}

async function expectReadOnly(reader: Page): Promise<void> {
  const notice = reader.locator('[data-chat-composer-status="read-only"]');
  const trigger = notice.getByRole('button', { name: 'Read only' });
  await expect(notice).toBeVisible();
  await trigger.focus();
  await expect(reader.locator('.chat-input-tooltip')).toHaveText(
    'Read access granted by Avery Owner',
  );
  await expect(reader.locator('button[data-chat-send]')).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'More actions' })).toHaveCount(0);
}

test.describe('workspace chat sharing', () => {
  test('an owner grants, revokes, reviews, and restores one former reader', async ({ browser }) => {
    const ownerContext = await member(browser, OWNER_KEY);
    const readerContext = await member(browser, READER_KEY);
    const owner = await ownerContext.newPage();
    const reader = await readerContext.newPage();
    try {
      await owner.goto('/chats/new?agent=echo-text');
      await expect(owner.getByTestId('new-chat-welcome')).toBeVisible();
      await owner.getByRole('textbox', { name: 'Message' }).fill('shared chat evidence');
      await owner.locator('button[data-chat-send]').click();
      await expect(owner.getByText('shared chat evidence', { exact: true })).toHaveCount(2);
      await expect.poll(() => new URL(owner.url()).pathname.startsWith('/chats/')).toBe(true);
      const contextId = new URL(owner.url()).pathname.split('/').at(-1);
      if (contextId === undefined || contextId === 'new')
        throw new Error('Expected an owned chat URL.');

      await share(owner, 'grant');
      await captureForDesignReview(owner, {
        route: '/chats/:chat',
        state: 'owner sharing controls',
        source: SOURCE,
      });

      await reader.goto('/chats');
      await expect(reader.locator(`a[href="/chats/${contextId}"]`)).toBeVisible();
      await reader.goto(`/chats/${contextId}`);
      await expect(reader.getByText('shared chat evidence', { exact: true })).toHaveCount(2);
      await expectReadOnly(reader);
      await captureForDesignReview(reader, {
        route: '/chats/:chat',
        state: 'active shared chat read-only',
        source: SOURCE,
      });

      await owner.goto(`/chats/${contextId}`);
      await share(owner, 'revoke');
      await owner.goto('/chats/new?agent=echo-text');
      await owner.getByRole('textbox', { name: 'Message' }).fill('unrelated private chat');
      await owner.locator('button[data-chat-send]').click();
      await expect.poll(() => new URL(owner.url()).pathname.startsWith('/chats/')).toBe(true);
      const unrelatedId = new URL(owner.url()).pathname.split('/').at(-1);
      if (unrelatedId === undefined || unrelatedId === 'new')
        throw new Error('Expected an unrelated private chat URL.');
      await reader.goto('/chats');
      await expect(reader.locator(`a[href="/chats/${contextId}"]`)).toHaveCount(0);
      await reader.goto(`/chats/${unrelatedId}`);
      await expect(reader.getByRole('button', { name: 'Request access' })).toHaveCount(0);
      await reader.goto(`/chats/${contextId}`);
      await expect(reader.getByRole('heading', { name: 'Chat access' })).toBeVisible();
      await expect(reader.getByRole('button', { name: 'Request access' })).toBeVisible();
      await captureForDesignReview(reader, {
        route: '/chats/:chat',
        state: 'former reader requestable',
        source: SOURCE,
      });

      await reader.getByRole('button', { name: 'Request access' }).click();
      await expect(
        reader.getByText('Your access request is waiting for the chat owner.'),
      ).toBeVisible();
      await owner.goto('/reviews');
      await expect(owner.getByRole('region', { name: 'Chat access requests' })).toContainText(
        READER_OWNER,
      );
      await captureForDesignReview(owner, {
        route: '/reviews',
        state: 'chat access request pending',
        source: SOURCE,
      });
      await owner.getByRole('button', { name: 'Grant access' }).click();

      await reader.reload();
      await expect(reader.getByText('shared chat evidence', { exact: true })).toHaveCount(2);
      await expectReadOnly(reader);
      await captureForDesignReview(reader, {
        route: '/chats/:chat',
        state: 'restored shared chat read-only',
        source: SOURCE,
      });
    } finally {
      await ownerContext.close();
      await readerContext.close();
    }
  });
});
