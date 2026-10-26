import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The end-to-end specs share two hosts' state, and the order they run in is the file order. These
 * checks keep the two ways a spec used to break the next one from coming back (COR-1687): chats
 * started on the second host and left there, which the fresh-host specs read as people's chats, and
 * a chat with the one agent the memory spec forgets the only memory of.
 */
const SPEC_DIRECTORY = join(import.meta.dir, 'e2e');

const specs = readdirSync(SPEC_DIRECTORY)
  .filter((name) => name.endsWith('.spec.ts'))
  .map((name) => ({ name, source: readFileSync(join(SPEC_DIRECTORY, name), 'utf8') }));

/** The source of every call `callee(` makes, up to its matching parenthesis. */
function callsOf(source: string, callee: string): string[] {
  const calls: string[] = [];
  let from = source.indexOf(`${callee}(`);
  while (from !== -1) {
    let depth = 0;
    let end = from + callee.length;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      if (source[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(from, end + 1));
    from = source.indexOf(`${callee}(`, end);
  }
  return calls;
}

describe('end-to-end spec isolation', () => {
  test('a spec that starts a chat on the second host deletes what it started', () => {
    const offenders = specs
      .filter(
        ({ source }) =>
          callsOf(source, 'runToEnd').some((call) => call.includes('E2E_BUREAU_URL')) ||
          (source.includes('baseURL: E2E_BUREAU_URL') && source.includes('/chat/new')),
      )
      .filter(({ source }) => !source.includes('deleteChats('))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  test('only the memory spec chats with the agent whose only memory it forgets', () => {
    const users = specs
      .filter(({ source }) => source.includes('TEXT_ECHO_SOLO_AGENT_NAME'))
      .map(({ name }) => name);
    expect(users).toEqual(['27-agent-memory.spec.ts']);
  });
});
