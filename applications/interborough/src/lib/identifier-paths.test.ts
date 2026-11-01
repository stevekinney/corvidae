/**
 * Where a chat session's path is built. A session named `new` is the new chat's route, and a
 * dot-only one is resolved away by the browser, so every path to a session goes through
 * `chatSessionPath`, which carries both in the query. A template that spells `/chats/${id}` itself
 * would open the wrong page for those ids.
 */
import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { chatSessionPath, identifierPath, withEscapedIdentifier } from './identifier-paths.ts';

describe('identifierPath', () => {
  test('escapes only what its route cannot carry, and keeps the rest of the query', () => {
    expect(identifierPath('chats', '/chats/:chat', 'new', new URLSearchParams({ a: '1' }))).toBe(
      '/chats/_?a=1&__weft_session_id=new',
    );
    expect(identifierPath('chats', '/chats/:chat', 'plain', new URLSearchParams({ a: '1' }))).toBe(
      '/chats/plain?a=1',
    );
    expect(identifierPath('anything', '/unlisted/:id', '..', new URLSearchParams())).toBe(
      '/anything/..',
    );
  });

  test('puts a schedule named new back on the edit page it was carried to', () => {
    const search = new URLSearchParams({ __weft_schedule_id: 'new' });
    for (const pattern of ['/schedules/:schedule', '/schedules/:schedule/edit']) {
      expect(
        withEscapedIdentifier({ definition: { pattern }, params: { schedule: '_' } }, search),
        pattern,
      ).toEqual({ schedule: 'new' });
    }
    // An identifier the route can carry is never taken from the query.
    expect(
      withEscapedIdentifier(
        { definition: { pattern: '/schedules/:schedule' }, params: { schedule: '_' } },
        new URLSearchParams({ __weft_schedule_id: 'plain' }),
      ),
    ).toEqual({ schedule: '_' });
  });

  test('builds the chat path the router reads back', () => {
    expect(chatSessionPath('new')).toBe('/chats/_?__weft_session_id=new');
  });
});

describe('the source', () => {
  test('builds no chat session path of its own', async () => {
    const root = join(import.meta.dir, '..');
    const offenders: string[] = [];
    for await (const file of new Glob('**/*.{ts,svelte}').scan({ cwd: root })) {
      if (file.includes('.test.') || file.endsWith('.test-support.ts')) continue;
      const text = await Bun.file(join(root, file)).text();
      if (/[`'"]\/chats\/\$\{/.test(text)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
  test('builds no run path of its own, so a dot-only run identifier is escaped', async () => {
    const root = join(import.meta.dir, '..');
    const offenders: string[] = [];
    for await (const file of new Glob('**/*.{ts,svelte}').scan({ cwd: root })) {
      if (file.includes('.test.') || file.endsWith('.test-support.ts')) continue;
      const text = await Bun.file(join(root, file)).text();
      if (/[`'"]\/runs\/\$\{/.test(text)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});
