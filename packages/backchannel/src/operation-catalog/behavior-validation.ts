import { z } from 'zod';
import type { ErasedOperation } from './types.ts';

function unwrap(schema: z.ZodType): z.ZodType {
  for (;;) {
    if (
      schema instanceof z.ZodOptional ||
      schema instanceof z.ZodNullable ||
      schema instanceof z.ZodDefault
    ) {
      schema = schema.unwrap() as z.ZodType;
      continue;
    }
    if (schema instanceof z.ZodUnion) {
      const options = (schema.options as z.ZodType[]).filter(
        (option) => !(option instanceof z.ZodNull) && !(option instanceof z.ZodUndefined),
      );
      if (options.length === 1) {
        schema = options[0]!;
        continue;
      }
    }
    return schema;
  }
}

function field(schema: z.ZodType, name: string, operation: string): z.ZodType {
  const object = unwrap(schema);
  if (!(object instanceof z.ZodObject) || !Object.hasOwn(object.shape, name)) {
    throw new Error(`operation "${operation}" behavior references missing field "${name}"`);
  }
  return object.shape[name] as z.ZodType;
}

function accepts(producer: z.ZodType, consumer: z.ZodType, pagination = false): boolean {
  if (!pagination && !acceptsAbsence(producer, consumer)) return false;
  if (!isComparable(unwrap(producer)) || !isComparable(unwrap(consumer))) return false;
  try {
    const source = z.toJSONSchema(unwrap(producer));
    const target = z.toJSONSchema(unwrap(consumer));
    if (JSON.stringify(canonicalSchema(source)) === JSON.stringify(canonicalSchema(target)))
      return true;
    return stringSubset(source, target);
  } catch {
    return false;
  }
}

function acceptsAbsence(producer: z.ZodType, consumer: z.ZodType): boolean {
  return (['null', 'undefined'] as const).every(
    (kind) => !allows(producer, kind) || allows(consumer, kind),
  );
}

function allows(schema: z.ZodType, kind: 'null' | 'undefined'): boolean {
  const terminatingTypes =
    kind === 'null' ? [z.ZodNull, z.ZodNullable] : [z.ZodUndefined, z.ZodOptional];
  if (terminatingTypes.some((type) => schema instanceof type)) return true;
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
    return allows(schema.unwrap() as z.ZodType, kind);
  if (schema instanceof z.ZodUnion)
    return (schema.options as z.ZodType[]).some((option) => allows(option, kind));
  return false;
}

function stringValues(schema: Record<string, unknown>): readonly string[] | undefined {
  if (typeof schema['const'] === 'string') return [schema['const']];
  if (Array.isArray(schema['enum']) && schema['enum'].every((value) => typeof value === 'string'))
    return schema['enum'];
  return undefined;
}

function stringSubset(source: Record<string, unknown>, target: Record<string, unknown>): boolean {
  if (source['type'] !== 'string' || target['type'] !== 'string') return false;
  const supported = new Set([
    '$schema',
    'description',
    'type',
    'enum',
    'const',
    'minLength',
    'maxLength',
    'pattern',
    'format',
  ]);
  if (Object.keys(target).some((key) => !supported.has(key))) return false;
  const values = stringValues(source);
  const accepted = stringValues(target);
  if (accepted && (!values || values.some((value) => !accepted.includes(value)))) return false;
  for (const key of ['pattern', 'format'] as const)
    if (target[key] !== undefined && source[key] !== target[key]) return false;
  return lengthSubset(source, target, values);
}

function lengthSubset(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  values: readonly string[] | undefined,
): boolean {
  for (const [key, compare] of [
    ['minLength', (left: number, right: number) => left >= right],
    ['maxLength', (left: number, right: number) => left <= right],
  ] as const) {
    const bound = target[key];
    if (bound === undefined) continue;
    if (typeof bound !== 'number') return false;
    if (values) {
      if (values.some((value) => !compare(value.length, bound))) return false;
    } else if (typeof source[key] !== 'number' || !compare(source[key], bound)) return false;
  }
  return true;
}

function canonicalSchema(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    const items = value.map((entry) => canonicalSchema(entry));
    return key === 'enum' || key === 'required'
      ? items.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : items;
  }
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([entryKey, entry]) => [entryKey, canonicalSchema(entry, entryKey)]),
  );
}

function isComparable(schema: z.ZodType, seen = new Set<z.ZodType>()): boolean {
  if (seen.has(schema)) return true;
  seen.add(schema);
  if (
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodLazy ||
    hasCallbackChecks(schema)
  )
    return false;
  return childSchemas(schema).every((child) => isComparable(child, seen));
}

function hasCallbackChecks(schema: z.ZodType): boolean {
  return (schema.def.checks ?? []).some((check) => {
    const kind = checkKind(check);
    return kind === 'custom' || kind === 'overwrite';
  });
}

function hasOverwrite(schema: z.ZodType): boolean {
  return (schema.def.checks ?? []).some((check) => checkKind(check) === 'overwrite');
}

function checkKind(check: object): string | undefined {
  const internals = Object.getOwnPropertyDescriptor(check, '_zod')?.value as
    { def?: { check?: string } } | undefined;
  return internals?.def?.check;
}

function rejectTransforms(schema: z.ZodType, operation: string, seen = new Set<z.ZodType>()): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  if (
    schema instanceof z.ZodPipe ||
    schema instanceof z.ZodTransform ||
    schema instanceof z.ZodLazy ||
    hasOverwrite(schema)
  )
    throw new Error(`operation "${operation}" behavior does not support schema transforms`);
  for (const child of childSchemas(schema)) rejectTransforms(child, operation, seen);
}

function narrowed(
  schema: z.ZodType,
  when: Readonly<Record<string, string>>,
  name: string,
): z.ZodType {
  const base = unwrap(schema);
  const variants = base instanceof z.ZodUnion ? (base.options as z.ZodType[]) : [base];
  const matches = variants.filter((variant) =>
    Object.entries(when).every(([key, value]) => {
      try {
        const discriminator = unwrap(field(variant, key, name));
        if (hasCallbackChecks(discriminator)) return false;
        if (discriminator instanceof z.ZodLiteral) return discriminator.values.has(value);
        if (discriminator instanceof z.ZodEnum) return discriminator.options.includes(value);
        return false;
      } catch {
        return false;
      }
    }),
  );
  if (matches.length !== 1)
    throw new Error(`operation "${name}" behavior observation does not select one variant`);
  return matches[0]!;
}

function childSchemas(schema: z.ZodType): z.ZodType[] {
  const children: z.ZodType[] =
    schema instanceof z.ZodObject ? (Object.values(schema.shape) as z.ZodType[]) : [];
  const visited = new Set<object>();
  const pending: unknown[] = [schema.def];
  while (pending.length) {
    const value = pending.pop();
    if (value instanceof z.ZodType) {
      children.push(value);
      continue;
    }
    if (value === null || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if ('value' in descriptor) pending.push(descriptor.value);
    }
  }
  return children;
}

type ReadBehavior = Extract<NonNullable<ErasedOperation['behavior']>, { kind: 'read' }>;
type CommandBehavior = Extract<NonNullable<ErasedOperation['behavior']>, { kind: 'command' }>;

function validatePage(
  operation: ErasedOperation,
  page: NonNullable<ReadBehavior['pagination']>,
): void {
  const name = operation.name;
  const items = unwrap(field(operation.outputSchema, page.items, name));
  if (!(items instanceof z.ZodArray))
    throw new Error(`operation "${name}" pagination items must be an array`);
  const item = unwrap(items.element as z.ZodType);
  const variants = item instanceof z.ZodUnion ? (item.options as z.ZodType[]) : [item];
  for (const key of page.itemKey) for (const variant of variants) field(variant, key, name);
  for (const filter of page.cursorFilters) field(operation.inputSchema, filter, name);
  if (!(unwrap(field(operation.outputSchema, page.total, name)) instanceof z.ZodNumber))
    throw new Error(`operation "${name}" pagination total must be a number`);
  if (
    !accepts(
      field(operation.outputSchema, page.nextCursor, name),
      field(operation.inputSchema, page.cursorInput, name),
      true,
    )
  )
    throw new Error(`operation "${name}" pagination cursors are incompatible`);
}

function validateRead(operation: ErasedOperation, behavior: ReadBehavior): void {
  const name = operation.name;
  const forbidden = [
    'invalidates',
    'observedInput',
    'replay',
    'responseDisposition',
    'conflictReasons',
    'effects',
  ];
  if (forbidden.some((key) => Object.hasOwn(behavior, key)))
    throw new Error(`operation "${name}" has conflicting read and command behavior`);
  if (operation.destructive) throw new Error(`operation "${name}" cannot be a destructive read`);
  for (const key of behavior.key ?? []) field(operation.inputSchema, key, name);
  if (behavior.pagination) validatePage(operation, behavior.pagination);
  if (behavior.cursor)
    field(operation.eventSchema ?? operation.outputSchema, behavior.cursor, name);
}

function lookupRead(
  byName: Map<string, ErasedOperation>,
  target: string,
  name: string,
): ErasedOperation & { behavior: ReadBehavior } {
  const read = byName.get(target);
  if (read?.behavior?.kind !== 'read')
    throw new Error(`operation "${name}" references missing read "${target}"`);
  return read as ErasedOperation & { behavior: ReadBehavior };
}

function validateObservation(
  operation: ErasedOperation,
  observed: NonNullable<CommandBehavior['observedInput']>,
  byName: Map<string, ErasedOperation>,
): void {
  const name = operation.name;
  const read = lookupRead(byName, observed.read, name);
  const output = narrowed(read.outputSchema, observed.when, name);
  for (const key of [observed.key, observed.revision]) {
    if (!accepts(field(output, key, name), field(operation.inputSchema, key, name)))
      throw new Error(`operation "${name}" observation field "${key}" is incompatible`);
  }
  if (!read.behavior.key?.includes(observed.key))
    throw new Error(`operation "${name}" observation key is not declared by its read`);
  if (
    !accepts(
      field(operation.inputSchema, observed.key, name),
      field(read.inputSchema, observed.key, name),
    )
  )
    throw new Error(`operation "${name}" observation key is incompatible with its read`);
}

function validateReplay(
  operation: ErasedOperation,
  replay: NonNullable<CommandBehavior['replay']>,
  byName: Map<string, ErasedOperation>,
): void {
  const name = operation.name;
  field(operation.inputSchema, replay.key, name);
  const resource = field(operation.outputSchema, replay.resource, name);
  const read = lookupRead(byName, replay.read, name);
  if (
    !read.behavior.key?.includes(replay.resource) ||
    !accepts(resource, field(read.inputSchema, replay.resource, name))
  )
    throw new Error(`operation "${name}" replay resource is incompatible with its read`);
}

function validateCommand(
  operation: ErasedOperation,
  behavior: CommandBehavior,
  byName: Map<string, ErasedOperation>,
): void {
  const name = operation.name;
  if (['key', 'pagination', 'cursor'].some((key) => Object.hasOwn(behavior, key)))
    throw new Error(`operation "${name}" has conflicting read and command behavior`);
  for (const target of behavior.invalidates ?? []) lookupRead(byName, target, name);
  for (const reason of behavior.conflictReasons ?? []) {
    if (!operation.conflictReasonTokens?.includes(reason))
      throw new Error(`operation "${name}" references unknown conflict reason "${reason}"`);
  }
  if (behavior.observedInput) validateObservation(operation, behavior.observedInput, byName);
  if (behavior.replay) validateReplay(operation, behavior.replay, byName);
}

/** Check declarative references before a host can start. */
export function validateOperationBehaviors(operations: readonly ErasedOperation[]): void {
  const byName = new Map(operations.map((operation) => [operation.name, operation]));
  for (const operation of operations) {
    const behavior = operation.behavior;
    if (!behavior) continue;
    rejectTransforms(operation.inputSchema, operation.name);
    rejectTransforms(operation.outputSchema, operation.name);
    if (operation.eventSchema) rejectTransforms(operation.eventSchema, operation.name);
    if (behavior.kind === 'read') validateRead(operation, behavior);
    else if (behavior.kind === 'command') validateCommand(operation, behavior, byName);
    else throw new Error(`operation "${operation.name}" has invalid behavior kind`);
  }
}
