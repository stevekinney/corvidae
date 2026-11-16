/** What the Plugins page works out around a plugin's configuration form: the changes, what to send, the field a refusal names. */
import { describe, expect, test } from 'bun:test';

import {
  configurationChanges,
  configurationToSave,
  hasConfigurationField,
  refusedField,
} from './plugin-configuration.ts';

describe('configurationChanges', () => {
  test('names only the fields whose value is not the one the form opened with', () => {
    const initial = { teamKey: 'COR', region: 'us', labels: [], snippets: false };
    const draft = { teamKey: 'ENG', region: 'us', labels: [], snippets: false };
    expect(configurationChanges(initial, draft)).toEqual({ teamKey: 'ENG' });
  });

  test('compares a list or a group by its content, not its identity', () => {
    expect(
      configurationChanges(
        { labels: ['a'], roots: [{ path: 'x' }] },
        { labels: ['a'], roots: [{ path: 'x' }] },
      ),
    ).toEqual({});
    expect(configurationChanges({ labels: ['a'] }, { labels: ['a', 'b'] })).toEqual({
      labels: ['a', 'b'],
    });
  });

  test('reports a field the draft dropped as changed to nothing, and one it gained as changed', () => {
    expect(configurationChanges({ teamKey: 'COR' }, {})).toEqual({ teamKey: undefined });
    expect(configurationChanges({}, { teamKey: 'COR' })).toEqual({ teamKey: 'COR' });
  });

  test('holds no change for a draft that is not an object', () => {
    expect(configurationChanges({ a: 1 }, null)).toEqual({ a: undefined });
    expect(configurationChanges(undefined, undefined)).toEqual({});
  });
});

describe('words and values', () => {
  test('sends only the fields that hold something', () => {
    expect(configurationToSave({ a: 'x', b: '', c: undefined, d: 0, e: false, f: [] })).toEqual({
      a: 'x',
      d: 0,
      e: false,
      f: [],
    });
  });

  test('finds the field a refusal names, and none for any other kind of refusal', () => {
    expect(refusedField('configuration.searchAddress')).toBe('searchAddress');
    expect(refusedField('configuration.roots.0.path')).toBe('roots');
    expect(refusedField('configuration')).toBeUndefined();
    expect(refusedField('enabled')).toBeUndefined();
    expect(refusedField(undefined)).toBeUndefined();
  });

  test('knows which fields the schema declares, so a refusal names a row only when there is one', () => {
    const schema = { type: 'object', properties: { teamKey: { type: 'string' } } };
    expect(hasConfigurationField(schema, 'teamKey')).toBe(true);
    expect(hasConfigurationField(schema, 'other')).toBe(false);
    expect(hasConfigurationField(schema, 'constructor')).toBe(false);
    expect(hasConfigurationField(null, 'teamKey')).toBe(false);
  });
});
