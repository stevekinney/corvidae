import { describe, expect, test } from 'bun:test';

import { appendAttributeFilter, parseAttributeFilters } from '../../../lib/attribute-filters.ts';
import {
  attributeFiltersToInvocationConditions,
  attributeFiltersToQueryConditionRows,
  createEmptyQueryConditionRow,
  invocationConditionsToAttributeFilters,
  invocationConditionsToFailureFilters,
  invocationConditionsToRawPreview,
  QUERY_FAILURE_FIELD_OPTIONS,
  queryConditionRowsToAttributeFilters,
  queryConditionRowsToRawPreview,
  type QueryConditionRow,
} from './query-builder.ts';

function row(
  key: string,
  operator: QueryConditionRow['operator'],
  value: string,
): QueryConditionRow {
  return { id: createEmptyQueryConditionRow().id, key, operator, value };
}

/** The values of the two built-in fields, which no search attribute's name starts with. */
const FAILED_STEP_FIELD = '@failedStep';
const RETRYING_FIELD = '@retrying';

describe('the built-in fields, Failed at step and Retrying (COR-2535)', () => {
  const condition = (field: string, operator: string, value: string) => ({
    id: createEmptyQueryConditionRow().id,
    field,
    operator,
    value,
  });

  test('are the list’s own filters, and no search attribute', () => {
    const conditions = [
      condition(FAILED_STEP_FIELD, 'eq', ' charge-card '),
      condition(RETRYING_FIELD, 'eq', 'true'),
      condition('customerTier', 'eq', 'gold'),
    ];
    expect(invocationConditionsToFailureFilters(conditions)).toEqual({
      failedStep: 'charge-card',
      retrying: true,
    });
    expect(invocationConditionsToAttributeFilters(conditions)).toEqual([
      { key: 'customerTier', value: 'gold' },
    ]);
  });

  test('keep a search attribute that has the same name apart', () => {
    const conditions = [condition('failedStep', 'eq', 'x'), condition('retrying', 'eq', 'true')];
    expect(invocationConditionsToFailureFilters(conditions)).toEqual({});
    expect(invocationConditionsToAttributeFilters(conditions)).toEqual([
      { key: 'failedStep', value: 'x' },
      { key: 'retrying', value: true },
    ]);
  });

  test('apply only as "is", with a value, and Retrying only as true or false', () => {
    expect(
      invocationConditionsToFailureFilters([
        condition(FAILED_STEP_FIELD, 'gt', 'a'),
        condition(FAILED_STEP_FIELD, 'eq', '  '),
        condition(RETRYING_FIELD, 'eq', 'maybe'),
        condition(RETRYING_FIELD, 'lte', 'true'),
      ]),
    ).toEqual({});
    expect(
      invocationConditionsToFailureFilters([
        condition(RETRYING_FIELD, 'eq', 'true'),
        condition(RETRYING_FIELD, 'eq', 'false'),
      ]),
    ).toEqual({ retrying: false });
  });

  test('are seeded from the list’s filter, and read back out of it unchanged', () => {
    const seeded = attributeFiltersToInvocationConditions([{ key: 'tier', value: 'gold' }], {
      failedStep: 'charge-card',
      retrying: false,
    });
    expect(seeded.map(({ field, operator, value }) => [field, operator, value])).toEqual([
      [FAILED_STEP_FIELD, 'eq', 'charge-card'],
      [RETRYING_FIELD, 'eq', 'false'],
      ['tier', 'eq', 'gold'],
    ]);
    expect(invocationConditionsToFailureFilters(seeded)).toEqual({
      failedStep: 'charge-card',
      retrying: false,
    });
    expect(invocationConditionsToAttributeFilters(seeded)).toEqual([
      { key: 'tier', value: 'gold' },
    ]);
    expect(invocationConditionsToRawPreview(seeded)).toEqual({
      and: [
        { failedStep: { eq: 'charge-card' } },
        { retrying: { eq: false } },
        { tier: { eq: 'gold' } },
      ],
    });
  });

  test('are offered as fields, Retrying as a boolean', () => {
    expect(QUERY_FAILURE_FIELD_OPTIONS).toEqual([
      { value: FAILED_STEP_FIELD, label: 'Failed at step' },
      { value: RETRYING_FIELD, label: 'Retrying', type: 'boolean' },
    ]);
  });
});

describe('queryConditionRowsToAttributeFilters', () => {
  test('drops blank rows (no key or no value yet)', () => {
    const rows = [row('', 'eq', ''), row('customerTier', 'eq', '')];
    expect(queryConditionRowsToAttributeFilters(rows)).toEqual([]);
  });

  test('one row per distinct key/operator', () => {
    const rows = [row('customerTier', 'eq', 'gold'), row('amount', 'gte', '500')];
    expect(queryConditionRowsToAttributeFilters(rows)).toEqual([
      { key: 'customerTier', value: 'gold' },
      { key: 'amount', gte: 500 },
    ]);
  });

  test('infers booleans and numbers, keeps everything else as a string', () => {
    const rows = [
      row('isFlaky', 'eq', 'true'),
      row('retryCount', 'eq', '3'),
      row('region', 'eq', 'us-east'),
    ];
    expect(queryConditionRowsToAttributeFilters(rows)).toEqual([
      { key: 'isFlaky', value: true },
      { key: 'retryCount', value: 3 },
      { key: 'region', value: 'us-east' },
    ]);
  });

  test('merges same-key eq rows into one filter with an array value', () => {
    const rows = [row('region', 'eq', 'us-east'), row('region', 'eq', 'us-west')];
    expect(queryConditionRowsToAttributeFilters(rows)).toEqual([
      { key: 'region', value: ['us-east', 'us-west'] },
    ]);
  });

  test('does not merge a range operator across rows with a different operator on the same key', () => {
    const rows = [row('amount', 'gte', '100'), row('amount', 'lte', '900')];
    expect(queryConditionRowsToAttributeFilters(rows)).toEqual([
      { key: 'amount', gte: 100, lte: 900 },
    ]);
  });
});

describe('attributeFiltersToQueryConditionRows', () => {
  test('expands an array-valued eq filter into one row per entry', () => {
    const rows = attributeFiltersToQueryConditionRows([
      { key: 'region', value: ['us-east', 'us-west'] },
    ]);
    expect(rows.map(({ key, operator, value }) => ({ key, operator, value }))).toEqual([
      { key: 'region', operator: 'eq', value: 'us-east' },
      { key: 'region', operator: 'eq', value: 'us-west' },
    ]);
  });

  test('emits one row per populated operator on a filter', () => {
    const rows = attributeFiltersToQueryConditionRows([{ key: 'amount', gte: 100, lte: 900 }]);
    expect(rows.map(({ key, operator, value }) => ({ key, operator, value }))).toEqual([
      { key: 'amount', operator: 'gte', value: '100' },
      { key: 'amount', operator: 'lte', value: '900' },
    ]);
  });

  test('round-trips through queryConditionRowsToAttributeFilters for a simple set', () => {
    const original = [row('customerTier', 'eq', 'gold'), row('amount', 'gte', '500')];
    const filters = queryConditionRowsToAttributeFilters(original);
    const rebuilt = attributeFiltersToQueryConditionRows(filters);
    expect(rebuilt.map(({ key, operator, value }) => ({ key, operator, value }))).toEqual([
      { key: 'customerTier', operator: 'eq', value: 'gold' },
      { key: 'amount', operator: 'gte', value: '500' },
    ]);
  });

  test('agrees with the URL grammar (attribute-filters.ts) on inference and merging', () => {
    const rows = [row('region', 'eq', 'us-east'), row('region', 'eq', 'us-west')];
    const filters = queryConditionRowsToAttributeFilters(rows);

    const params = new URLSearchParams();
    for (const filter of filters) appendAttributeFilter(params, filter);
    const reparsed = parseAttributeFilters(params);

    expect(reparsed).toEqual(filters);
  });
});

describe('queryConditionRowsToRawPreview', () => {
  test('matches the design mock shape: { and: [{ key: { op: value } }] }', () => {
    const rows = [row('customerTier', 'eq', 'gold'), row('amount', 'gte', '500')];
    expect(queryConditionRowsToRawPreview(rows)).toEqual({
      and: [{ customerTier: { eq: 'gold' } }, { amount: { gte: 500 } }],
    });
  });

  test('empty rows produce an empty AND list', () => {
    expect(queryConditionRowsToRawPreview([])).toEqual({ and: [] });
  });
});

describe('createEmptyQueryConditionRow', () => {
  test('produces a blank eq row with a unique id', () => {
    const a = createEmptyQueryConditionRow();
    const b = createEmptyQueryConditionRow();
    expect(a.key).toBe('');
    expect(a.operator).toBe('eq');
    expect(a.value).toBe('');
    expect(a.id).not.toBe(b.id);
  });
});
