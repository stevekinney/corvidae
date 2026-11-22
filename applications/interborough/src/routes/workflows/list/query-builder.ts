/**
 * Search-attribute query builder — pure logic (plan §9.2 T2.2, §10.3).
 *
 * Cinder 0.19.0's `mode="flat-conditions"` now covers this console's
 * complete UI contract: free-text field entry, the fixed eq/gt/lt/gte/lte
 * operator set, and type-aware value controls. The component owns row
 * composition; this module only adapts its string conditions to the frozen
 * URL filter shape.
 *
 * This module is the pure half: condition rows ↔ `AttributeFilter[]` (the
 * shape `src/lib/attribute-filters.ts` already serializes to/from the URL),
 * plus a read-only `{ and: [...] }` JSON projection matching the design's
 * "Raw toggle" panel (a preview, not an editable raw mode — the design mock
 * shows no JSON input for this builder, only a read-only equivalent).
 * `query-builder.svelte` is the thin UI wrapper.
 */
import type { InvocationRuleCondition } from '@lostgradient/cinder';

import type { AttributeFilter, AttributeScalar } from '../../../lib/attribute-filters.ts';

export type QueryConditionOperator = 'eq' | 'gt' | 'lt' | 'gte' | 'lte';

export const QUERY_CONDITION_OPERATORS: readonly QueryConditionOperator[] = [
  'eq',
  'gt',
  'lt',
  'gte',
  'lte',
];
const QUERY_CONDITION_OPERATOR_SET: ReadonlySet<string> = new Set(QUERY_CONDITION_OPERATORS);

function isQueryConditionOperator(value: string): value is QueryConditionOperator {
  return QUERY_CONDITION_OPERATOR_SET.has(value);
}

/** One condition row in the visual builder. `value` is always the raw text the operator input holds — type inference happens on export, mirroring the URL layer (`inferAttributeScalar`). */
export interface QueryConditionRow {
  readonly id: string;
  readonly key: string;
  readonly operator: QueryConditionOperator;
  readonly value: string;
}

let rowIdCounter = 0;

/** Generates a stable-enough id for a freshly added row (keyed `{#each}` identity only — never persisted). */
export function nextQueryConditionRowId(): string {
  rowIdCounter += 1;
  return `condition-${rowIdCounter}`;
}

function emptyRow(): QueryConditionRow {
  return { id: nextQueryConditionRowId(), key: '', operator: 'eq', value: '' };
}

/** A single fresh, empty condition row — the "Add condition" affordance. */
export function createEmptyQueryConditionRow(): QueryConditionRow {
  return emptyRow();
}

/**
 * Same scalar-inference rule the URL layer uses (`attribute-filters.ts`
 * `inferAttributeScalar`) — kept as a private copy rather than imported so
 * this module has no runtime dependency direction onto the URL grammar
 * module beyond the shared `AttributeFilter` type; the two are proven to
 * agree by `query-builder.test.ts`'s round-trip-through-the-URL-serializer
 * case.
 */
function inferScalar(raw: string): AttributeScalar {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const asNumber = Number(raw);
  if (!Number.isNaN(asNumber) && raw.trim() !== '') return asNumber;
  return raw;
}

function isBlank(row: QueryConditionRow): boolean {
  return row.key.trim() === '' || row.value.trim() === '';
}

/**
 * Rows → `AttributeFilter[]`. Blank rows (no key or no value yet — an
 * in-progress "Add condition" row) are dropped rather than serialized.
 * `eq` rows sharing the same key are merged into one filter with an array
 * value, matching what a round trip through `parseAttributeFilters` would
 * produce for the same rows serialized to the URL and reparsed — so
 * rebuilding rows from the reparsed filters (`attributeFiltersToRows`)
 * reproduces the merged shape, not the original per-row split. Range
 * operators (gt/lt/gte/lte) keep one filter object per key+operator; a
 * later row silently wins over an earlier one sharing both, which is an
 * accepted rough edge for a rare, self-inflicted input (two lower bounds on
 * the same key) rather than added row-level validation.
 */
export function queryConditionRowsToAttributeFilters(
  rows: readonly QueryConditionRow[],
): AttributeFilter[] {
  const byKey = new Map<string, AttributeFilter>();
  const order: string[] = [];

  for (const row of rows) {
    if (isBlank(row)) continue;
    const scalar = inferScalar(row.value);
    const existing = byKey.get(row.key);
    if (existing) {
      applyOperator(existing, row.operator, scalar);
      continue;
    }
    const filter: AttributeFilter = { key: row.key };
    applyOperator(filter, row.operator, scalar);
    byKey.set(row.key, filter);
    order.push(row.key);
  }

  return order.map((key) => byKey.get(key)).filter((filter): filter is AttributeFilter => !!filter);
}

function applyOperator(
  filter: AttributeFilter,
  operator: QueryConditionOperator,
  scalar: AttributeScalar,
): void {
  if (operator === 'eq') {
    filter.value =
      filter.value === undefined
        ? scalar
        : [...(Array.isArray(filter.value) ? filter.value : [filter.value]), scalar];
    return;
  }
  filter[operator] = scalar;
}

/** `AttributeFilter[]` → rows. The inverse of the merge in `queryConditionRowsToAttributeFilters`: an array-valued `eq` filter expands into one row per array entry so every value stays independently editable/removable. */
export function attributeFiltersToQueryConditionRows(
  filters: readonly AttributeFilter[],
): QueryConditionRow[] {
  const rows: QueryConditionRow[] = [];

  for (const filter of filters) {
    if (filter.value !== undefined) {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      for (const value of values) {
        rows.push({
          id: nextQueryConditionRowId(),
          key: filter.key,
          operator: 'eq',
          value: String(value),
        });
      }
    }
    for (const operator of ['gt', 'lt', 'gte', 'lte'] as const) {
      const value = filter[operator];
      if (value !== undefined) {
        rows.push({
          id: nextQueryConditionRowId(),
          key: filter.key,
          operator,
          value: String(value),
        });
      }
    }
  }

  return rows;
}

type RawPreviewOperatorMap = Partial<
  Record<QueryConditionOperator, AttributeScalar | AttributeScalar[]>
>;

/** Read-only `{ and: [...] }` JSON projection for the design's "Raw toggle" preview panel. */
export function queryConditionRowsToRawPreview(
  rows: readonly QueryConditionRow[],
): Readonly<{ and: Record<string, RawPreviewOperatorMap>[] }> {
  const filters = queryConditionRowsToAttributeFilters(rows);
  const and = filters.map((filter) => {
    const entry: RawPreviewOperatorMap = {};
    if (filter.value !== undefined) entry.eq = filter.value;
    if (filter.gt !== undefined) entry.gt = filter.gt;
    if (filter.lt !== undefined) entry.lt = filter.lt;
    if (filter.gte !== undefined) entry.gte = filter.gte;
    if (filter.lte !== undefined) entry.lte = filter.lte;
    return { [filter.key]: entry };
  });
  return { and };
}

/**
 * The two built-in fields beside the search attributes (COR-2535): the step a failed run stopped
 * at, and whether a run is retrying an activity. They are not search attributes: each is a field of
 * Weft's list itself (`failedStep`, `retrying`). The `@` in front keeps them apart from a search
 * attribute that has the same name, which no attribute's name starts with.
 */
export const FAILED_STEP_FIELD = '@failedStep';
export const RETRYING_FIELD = '@retrying';

/** What the two built-in fields hold, as the list's own filter has them. */
export interface QueryFailureFilters {
  readonly failedStep?: string;
  readonly retrying?: boolean;
}

/**
 * The built-in fields as the builder offers them. Retrying is a boolean, so its value is a choice
 * of true and false; Failed at step takes the name of the step as typed.
 */
export const QUERY_FAILURE_FIELD_OPTIONS: readonly {
  readonly value: string;
  readonly label: string;
  readonly type?: 'boolean';
}[] = [
  { value: FAILED_STEP_FIELD, label: 'Failed at step' },
  { value: RETRYING_FIELD, label: 'Retrying', type: 'boolean' },
];

/** Converts URL-backed filters into Cinder's flat-conditions model. */
export function attributeFiltersToInvocationConditions(
  filters: readonly AttributeFilter[],
  failure: QueryFailureFilters = {},
): InvocationRuleCondition[] {
  const failureRows: InvocationRuleCondition[] = [
    ...(failure.failedStep === undefined
      ? []
      : [
          {
            id: nextQueryConditionRowId(),
            field: FAILED_STEP_FIELD,
            operator: 'eq',
            value: failure.failedStep,
          },
        ]),
    ...(failure.retrying === undefined
      ? []
      : [
          {
            id: nextQueryConditionRowId(),
            field: RETRYING_FIELD,
            operator: 'eq',
            value: String(failure.retrying),
          },
        ]),
  ];
  return [
    ...failureRows,
    ...attributeFiltersToQueryConditionRows(filters).map(({ id, key, operator, value }) => ({
      id,
      field: key,
      operator,
      value,
    })),
  ];
}

function isFailureField(field: string): boolean {
  return field === FAILED_STEP_FIELD || field === RETRYING_FIELD;
}

/**
 * The built-in fields out of Cinder's conditions. A built-in field means "is", so a row that tests
 * it with another operator, has no value yet, or (Retrying) holds anything but true or false is
 * not applied, as a blank row is not. A later row of the same field wins.
 */
export function invocationConditionsToFailureFilters(
  conditions: readonly InvocationRuleCondition[],
): QueryFailureFilters {
  let failedStep: string | undefined;
  let retrying: boolean | undefined;
  for (const { field, operator, value } of conditions) {
    if (operator !== 'eq') continue;
    if (field === FAILED_STEP_FIELD && value.trim() !== '') failedStep = value.trim();
    if (field === RETRYING_FIELD && (value === 'true' || value === 'false')) {
      retrying = value === 'true';
    }
  }
  return {
    ...(failedStep === undefined ? {} : { failedStep }),
    ...(retrying === undefined ? {} : { retrying }),
  };
}

/** Converts Cinder's flat conditions back to the URL-backed filter shape. */
export function invocationConditionsToAttributeFilters(
  conditions: readonly InvocationRuleCondition[],
): AttributeFilter[] {
  return queryConditionRowsToAttributeFilters(
    conditions
      .filter(({ field }) => !isFailureField(field))
      .map(({ id, field, operator, value }) => ({
        id,
        key: field,
        operator: isQueryConditionOperator(operator) ? operator : 'eq',
        value,
      })),
  );
}

/** Builds the existing read-only raw preview from Cinder conditions. */
export function invocationConditionsToRawPreview(
  conditions: readonly InvocationRuleCondition[],
): Readonly<{ and: Record<string, RawPreviewOperatorMap>[] }> {
  const { and } = queryConditionRowsToRawPreview(
    conditions
      .filter(({ field }) => !isFailureField(field))
      .map(({ id, field, operator, value }) => ({
        id,
        key: field,
        operator: isQueryConditionOperator(operator) ? operator : 'eq',
        value,
      })),
  );
  const { failedStep, retrying } = invocationConditionsToFailureFilters(conditions);
  return {
    and: [
      ...(failedStep === undefined ? [] : [{ failedStep: { eq: failedStep } }]),
      ...(retrying === undefined ? [] : [{ retrying: { eq: retrying } }]),
      ...and,
    ],
  };
}
