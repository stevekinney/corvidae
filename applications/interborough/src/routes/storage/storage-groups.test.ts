/**
 * How the explorer words a key: its group in plain words, a UUID shortened in the table, the lock
 * line's prefix, and when it was written, as the pane's header says it.
 */
import { describe, expect, test } from 'bun:test';

import {
  abbreviateKey,
  GROUP_NAMES,
  groupName,
  keyGroupName,
  lockedPrefix,
  updatedPhrase,
} from './storage-groups.ts';

describe('groupName', () => {
  test('names the groups this application writes, and leaves another as its prefix', () => {
    expect(groupName('agent-session:')).toBe('Chat sessions');
    expect(groupName('app:')).toBe('App data and memory');
    expect(groupName('audit:')).toBe('Audit log');
    expect(groupName('e2e-storage:')).toBe('e2e-storage:');
  });

  test('never answers for a name the table inherits from Object', () => {
    expect(groupName('constructor')).toBe('constructor');
    expect(groupName('toString')).toBe('toString');
  });

  test('no two groups share a word, so the Group select has no duplicate', () => {
    const words = Object.values(GROUP_NAMES);
    expect(new Set(words).size).toBe(words.length);
  });
});

describe('keyGroupName', () => {
  test('is the word for the key’s group, or the word given for a key in none', () => {
    expect(keyGroupName('agent-session:summary-index', 'None')).toBe('Chat sessions');
    expect(keyGroupName('settings', 'None')).toBe('None');
    expect(keyGroupName('unknown:thing', 'None')).toBe('unknown:');
  });
});

describe('abbreviateKey', () => {
  test('cuts each UUID to its first eight characters and an ellipsis', () => {
    expect(abbreviateKey('agent-session:415b1fd8-77c2-4f0e-9a6d-2b1c0e5f3a11:messages')).toBe(
      'agent-session:415b1fd8…:messages',
    );
    expect(abbreviateKey('run:run-1-12b71b8b-d378-4e94-802b-1cee16fa9bcc')).toBe(
      'run:run-1-12b71b8b…',
    );
  });

  test('leaves a key with no UUID, and one that only looks like the start of one, as it is', () => {
    expect(abbreviateKey('memory:preferences')).toBe('memory:preferences');
    expect(abbreviateKey('a:415b1fd8-77c2')).toBe('a:415b1fd8-77c2');
  });
});

describe('lockedPrefix', () => {
  test('names the group when the family’s prefix is the start of it', () => {
    expect(lockedPrefix('agent-session:summary-index', 'agent-session')).toBe('agent-session:');
    expect(lockedPrefix('wf:order-1', 'wf:')).toBe('wf:');
  });

  test('names the family’s own prefix for a key that is in no group, or another one', () => {
    expect(lockedPrefix('settings', 'settings')).toBe('settings');
    expect(lockedPrefix('skill:summarize', 'settings')).toBe('settings');
  });
});

describe('updatedPhrase', () => {
  const now = Date.UTC(2026, 10, 2, 16, 46);
  const options = { now, timeZone: 'America/Chicago' };

  test('says today with the time, yesterday alone, and an older day with its date', () => {
    expect(updatedPhrase(Date.UTC(2026, 10, 2, 16, 44), options)).toBe('today, 10:44 AM');
    expect(updatedPhrase(Date.UTC(2026, 10, 1, 22, 12), options)).toBe('yesterday');
    expect(updatedPhrase(Date.UTC(2026, 9, 29, 12, 0), options)).toBe('Thu Oct 29, 7:00 AM');
  });

  test('has no phrase for a backend that records no write time', () => {
    expect(updatedPhrase(null, options)).toBeNull();
  });
});
