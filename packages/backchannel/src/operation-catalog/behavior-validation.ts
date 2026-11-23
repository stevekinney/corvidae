import { z } from 'zod';
import type { ErasedOperation } from './types.ts';

function unwrap(schema: z.ZodType): z.ZodType {
  while (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  )
    schema = schema.unwrap() as z.ZodType;
  return schema;
}

function field(schema: z.ZodType, name: string, operation: string): z.ZodType {
  const object = unwrap(schema);
  if (!(object instanceof z.ZodObject) || !Object.hasOwn(object.shape, name)) {
    throw new Error(`operation "${operation}" behavior references missing field "${name}"`);
  }
  return object.shape[name] as z.ZodType;
}

function sameType(left: z.ZodType, right: z.ZodType): boolean {
  return unwrap(left).def.type === unwrap(right).def.type;
}

function rejectTransforms(schema: z.ZodType, operation: string, seen = new Set<z.ZodType>()): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  if (schema instanceof z.ZodPipe || schema instanceof z.ZodTransform)
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
        return field(variant, key, name).safeParse(value).success;
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
  if (schema instanceof z.ZodObject) return Object.values(schema.shape) as z.ZodType[];
  if (schema instanceof z.ZodArray) return [schema.element as z.ZodType];
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  )
    return [schema.unwrap() as z.ZodType];
  if (schema instanceof z.ZodUnion) return schema.options as z.ZodType[];
  return [];
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
  for (const key of page.itemKey) field(items.element as z.ZodType, key, name);
  for (const filter of page.cursorFilters) field(operation.inputSchema, filter, name);
  if (!(unwrap(field(operation.outputSchema, page.total, name)) instanceof z.ZodNumber))
    throw new Error(`operation "${name}" pagination total must be a number`);
  if (
    !sameType(
      field(operation.inputSchema, page.cursorInput, name),
      field(operation.outputSchema, page.nextCursor, name),
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
    if (!sameType(field(operation.inputSchema, key, name), field(output, key, name)))
      throw new Error(`operation "${name}" observation field "${key}" is incompatible`);
  }
  if (!read.behavior.key?.includes(observed.key))
    throw new Error(`operation "${name}" observation key is not declared by its read`);
  if (
    !sameType(
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
    !sameType(resource, field(read.inputSchema, replay.resource, name))
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
