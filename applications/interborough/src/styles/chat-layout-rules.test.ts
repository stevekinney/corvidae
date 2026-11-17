import { describe, expect, test } from 'bun:test';

const read = (path: string): Promise<string> => Bun.file(new URL(path, import.meta.url)).text();

/** The declarations of the first rule in `source` whose selector is exactly `selector`. */
function ruleOf(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('}', start));
}

// Chat is a conversation (COR-2327): the list and the open chat sit on the page with no frame of
// their own, and the transcript and its composer share one reading column centred in the pane. The
// browser specifications measure the result; these keep the rules from being dropped.
describe('the chat page’s layout', () => {
  test('the list and the open chat draw no frame around them', async () => {
    const rule = ruleOf(await read('./chat.css'), '.ib-chats');
    expect(rule).not.toMatch(/(^|[\s;{])border(-radius)?\s*:/);
    expect(rule).not.toMatch(/box-shadow\s*:/);
  });

  test('the outlet pads neither the list nor the conversation, so the list is flush to the rail and the top bar', async () => {
    const rule = ruleOf(await read('./foundation.css'), '.weft-shell-outlet:has(.ib-chats)');
    expect(rule).toMatch(/padding:\s*0;/);
  });

  test('on a phone the outlet keeps only the gutter’s remainder around the conversation, so the composer stands 16px from the sides and from the tab bar', async () => {
    const rule = ruleOf(
      await read('./foundation.css'),
      '.weft-shell-outlet:has(.ib-chats .weft-chat-route)',
    );
    expect(rule).toMatch(
      /padding-inline:\s*calc\(var\(--cinder-space-4\) - var\(--cinder-space-3\)\)/,
    );
    // The duplicate that made the gap 36px: the outlet's own 24px under the composer's 12px.
    expect(rule).toMatch(
      /padding-block-end:\s*calc\(var\(--cinder-space-4\) - var\(--cinder-space-3\)\)/,
    );
  });

  test('the header is laid over the conversation on Cinder’s translucent ground', async () => {
    const rule = ruleOf(await read('./chat.css'), '.weft-chat-head');
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/inset-inline:\s*0/);
    const source = await read('../routes/chat/chat-conversation.svelte');
    expect(source).toContain('class="weft-chat-head cinder-translucent-surface"');
    expect(source).toContain("'--cinder-chat-overlay-inset-start'");
  });

  test('the conversation is one centred reading column of at most 760px', async () => {
    const rule = ruleOf(await read('./chat.css'), '.weft-chat-surface');
    expect(rule).toMatch(/max-inline-size:\s*47\.5rem/);
    expect(rule).toMatch(/margin-inline:\s*auto/);
    expect(rule).not.toMatch(/(^|[\s;{])border\s*:/);
  });
});
