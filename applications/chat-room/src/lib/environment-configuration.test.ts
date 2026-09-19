import { afterEach, expect, test } from 'bun:test';
import {
  readFixtureEnvironment,
  readServerOwnedStorageEnvironment,
} from './environment-configuration.ts';

const originalDatabase = process.env['CHAT_ROOM_SERVER_OWNED_DATABASE'];
const originalHostListener = process.env['HOST_LISTENER'];
const originalBlockTeardown = process.env['BLOCK_TEARDOWN'];

afterEach(() => {
  if (originalDatabase === undefined) delete process.env['CHAT_ROOM_SERVER_OWNED_DATABASE'];
  else process.env['CHAT_ROOM_SERVER_OWNED_DATABASE'] = originalDatabase;
  if (originalHostListener === undefined) delete process.env['HOST_LISTENER'];
  else process.env['HOST_LISTENER'] = originalHostListener;
  if (originalBlockTeardown === undefined) delete process.env['BLOCK_TEARDOWN'];
  else process.env['BLOCK_TEARDOWN'] = originalBlockTeardown;
});

test('standalone storage configuration is read on each call without requiring credentials', () => {
  delete process.env['CHAT_ROOM_SERVER_OWNED_DATABASE'];
  expect(readServerOwnedStorageEnvironment().chatRoomServerOwnedDatabase).toBeUndefined();
  process.env['CHAT_ROOM_SERVER_OWNED_DATABASE'] = '';
  expect(readServerOwnedStorageEnvironment().chatRoomServerOwnedDatabase).toBe('');
  process.env['CHAT_ROOM_SERVER_OWNED_DATABASE'] = ':memory:';
  expect(readServerOwnedStorageEnvironment().chatRoomServerOwnedDatabase).toBe(':memory:');
});

test('fixture flags retain the exact 1 convention rather than general boolean coercion', () => {
  for (const value of ['true', 'yes', 'on', '0', '']) {
    process.env['HOST_LISTENER'] = value;
    process.env['BLOCK_TEARDOWN'] = value;
    expect(readFixtureEnvironment().hostListener).toBe(false);
    expect(readFixtureEnvironment().blockTeardown).toBe(false);
  }
  process.env['HOST_LISTENER'] = '1';
  process.env['BLOCK_TEARDOWN'] = '1';
  expect(readFixtureEnvironment().hostListener).toBe(true);
  expect(readFixtureEnvironment().blockTeardown).toBe(true);
});
