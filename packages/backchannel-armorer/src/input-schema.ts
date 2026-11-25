import { z } from 'zod';

/** Reject input that would be changed by the catalog before the toolbox validates it. */
export function projectedInputSchema(
  input: z.ZodType,
  wireSchema: unknown,
  name: string,
): z.ZodObject {
  if (!(input instanceof z.ZodObject)) {
    throw new Error(`selection "${name}" requires a Zod object input schema`);
  }
  const seen = new Set<object>();
  const pending: unknown[] = [input];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (
      value instanceof z.ZodPipe ||
      value instanceof z.ZodTransform ||
      value instanceof z.ZodDefault ||
      value instanceof z.ZodPrefault ||
      value instanceof z.ZodCatch ||
      value instanceof z.ZodLazy
    ) {
      throw new Error(`selection "${name}" does not support input transforms`);
    }
    if (value instanceof z.ZodType) {
      if (value instanceof z.ZodObject) pending.push(...Object.values(value.shape));
      if (
        (value.def.checks ?? []).some((check) => {
          const internal = Object.getOwnPropertyDescriptor(check, '_zod')?.value as
            { def?: { check?: string } } | undefined;
          return internal?.def?.check === 'overwrite';
        })
      ) {
        throw new Error(`selection "${name}" does not support input transforms`);
      }
      pending.push(value.def);
      continue;
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if ('value' in descriptor) pending.push(descriptor.value);
    }
  }
  if (wireSchema !== undefined) {
    let generated: unknown;
    try {
      generated = z.toJSONSchema(input, { io: 'input' });
    } catch {
      throw new Error(`selection "${name}" has an unsupported input schema`);
    }
    if (JSON.stringify(canonical(generated)) !== JSON.stringify(canonical(wireSchema))) {
      throw new Error(`selection "${name}" has incompatible runtime and wire schemas`);
    }
  }
  return input;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '$schema')
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}
