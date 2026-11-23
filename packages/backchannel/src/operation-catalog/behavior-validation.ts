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
  if (schema instanceof z.ZodObject)
    for (const child of Object.values(schema.shape))
      rejectTransforms(child as z.ZodType, operation, seen);
  if (schema instanceof z.ZodArray) rejectTransforms(schema.element as z.ZodType, operation, seen);
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  )
    rejectTransforms(schema.unwrap() as z.ZodType, operation, seen);
  if (schema instanceof z.ZodUnion)
    for (const child of schema.options) rejectTransforms(child as z.ZodType, operation, seen);
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

/** Check declarative references before a host can start. */
export function validateOperationBehaviors(operations: readonly ErasedOperation[]): void {
  const byName = new Map(operations.map((operation) => [operation.name, operation]));
  for (const operation of operations) {
    const behavior = operation.behavior;
    if (!behavior) continue;
    const name = operation.name;
    rejectTransforms(operation.inputSchema, name);
    rejectTransforms(operation.outputSchema, name);
    if (operation.eventSchema) rejectTransforms(operation.eventSchema, name);
    if (behavior.kind === 'read') {
      if (
        'invalidates' in behavior ||
        'observedInput' in behavior ||
        'replay' in behavior ||
        'responseDisposition' in behavior ||
        'conflictReasons' in behavior ||
        'effects' in behavior
      )
        throw new Error(`operation "${name}" has conflicting read and command behavior`);
      if (operation.destructive)
        throw new Error(`operation "${name}" cannot be a destructive read`);
      for (const key of behavior.key ?? []) field(operation.inputSchema, key, name);
      if (behavior.pagination) {
        const page = behavior.pagination;
        const items = unwrap(field(operation.outputSchema, page.items, name));
        if (!(items instanceof z.ZodArray))
          throw new Error(`operation "${name}" pagination items must be an array`);
        for (const key of page.itemKey) field(items.element as z.ZodType, key, name);
        for (const filter of page.cursorFilters) field(operation.inputSchema, filter, name);
        const total = unwrap(field(operation.outputSchema, page.total, name));
        if (!(total instanceof z.ZodNumber))
          throw new Error(`operation "${name}" pagination total must be a number`);
        if (
          !sameType(
            field(operation.inputSchema, page.cursorInput, name),
            field(operation.outputSchema, page.nextCursor, name),
          )
        )
          throw new Error(`operation "${name}" pagination cursors are incompatible`);
      }
      if (behavior.cursor)
        field(operation.eventSchema ?? operation.outputSchema, behavior.cursor, name);
      continue;
    }
    if (behavior.kind !== 'command')
      throw new Error(`operation "${name}" has invalid behavior kind`);
    if ('key' in behavior || 'pagination' in behavior || 'cursor' in behavior)
      throw new Error(`operation "${name}" has conflicting read and command behavior`);
    for (const target of behavior.invalidates ?? []) {
      if (byName.get(target)?.behavior?.kind !== 'read')
        throw new Error(`operation "${name}" references missing read "${target}"`);
    }
    for (const reason of behavior.conflictReasons ?? []) {
      if (!operation.conflictReasonTokens?.includes(reason))
        throw new Error(`operation "${name}" references unknown conflict reason "${reason}"`);
    }
    if (behavior.observedInput) {
      const observed = behavior.observedInput;
      const read = byName.get(observed.read);
      if (read?.behavior?.kind !== 'read')
        throw new Error(`operation "${name}" references missing read "${observed.read}"`);
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
    if (behavior.replay) {
      const replay = behavior.replay;
      field(operation.inputSchema, replay.key, name);
      const resource = field(operation.outputSchema, replay.resource, name);
      const read = byName.get(replay.read);
      if (read?.behavior?.kind !== 'read')
        throw new Error(`operation "${name}" references missing read "${replay.read}"`);
      if (
        !read.behavior.key?.includes(replay.resource) ||
        !sameType(resource, field(read.inputSchema, replay.resource, name))
      )
        throw new Error(`operation "${name}" replay resource is incompatible with its read`);
    }
  }
}
