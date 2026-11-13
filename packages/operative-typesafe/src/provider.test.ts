import { describe, expect, test } from 'bun:test';

import { TYPESAFE_JEV_MODEL, typesafeProvider, typesafeRows } from './provider';

describe('the typesafe provider (COR-2157)', () => {
  test('is decision-only: it names itself, decides, and has no generate or stream', () => {
    expect(typesafeProvider.name).toBe('typesafe');
    expect(typesafeProvider.decide).toBeFunction();
    expect(Object.hasOwn(typesafeProvider, 'generate')).toBe(false);
    expect(Object.hasOwn(typesafeProvider, 'stream')).toBe(false);
  });

  test('builds Jev from the configuration key, serving the kinds its row declares', () => {
    const jev = typesafeProvider.decide({
      provider: 'typesafe',
      model: TYPESAFE_JEV_MODEL,
      apiKey: 'fixture-key',
    });
    const row = typesafeRows[0];
    expect([...jev.kinds].toSorted()).toEqual([...(row?.decisions?.kinds ?? [])].toSorted());
  });

  test('refuses a blank or absent key without putting one in the message', () => {
    expect(() => typesafeProvider.decide({ provider: 'typesafe', model: 'jev' })).toThrow(
      TypeError,
    );
    expect(() =>
      typesafeProvider.decide({ provider: 'typesafe', model: 'jev', apiKey: '  ' }),
    ).toThrow('needs an apiKey');
  });

  test('has one catalog row, typesafe/jev, that only decides, has no price and cannot be the fallback', () => {
    expect(typesafeRows.map((row) => `${row.provider}/${row.model}`)).toEqual(['typesafe/jev']);
    const row = typesafeRows[0];
    expect(row?.decisions).toEqual({ kinds: ['boolean', 'choice', 'scale'], only: true });
    expect(row?.structuredOutput).toBe(false);
    expect(row?.pricing).toBeUndefined();
    expect(row?.provider).toBe(typesafeProvider.name);
  });
});
