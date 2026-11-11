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

  test('the conversation is one centred reading column of at most 760px', async () => {
    const rule = ruleOf(await read('./chat.css'), '.weft-chat-surface');
    expect(rule).toMatch(/max-inline-size:\s*47\.5rem/);
    expect(rule).toMatch(/margin-inline:\s*auto/);
    expect(rule).not.toMatch(/(^|[\s;{])border\s*:/);
  });
});
