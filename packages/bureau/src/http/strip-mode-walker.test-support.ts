/**
 * Finds the nested object schemas of an operation's input that run in Zod's strip mode (COR-1595).
 *
 * Zod 4 silently drops the undeclared keys of a `z.object`. Weft's parse stage applies an
 * operation's `unknownKeyPolicy` to the payload's top level only, so a nested strip-mode object
 * loses a key the published contract calls closed, and the write that carried it succeeds. The
 * contract's converter calls an object closed unless it has a `catchall`, so this walk uses the
 * same test: a `z.object` whose `def.catchall` is `undefined` is in strip mode, and
 * `z.strictObject` (a `never` catchall) and `z.looseObject` (an `unknown` one) are not.
 */
import type { z } from 'zod';

/** A schema's definition, as far as the walk reads it. Zod types its own internals per kind. */
type Definition = Record<string, unknown> & { readonly type: string };

/** The Zod types that hold no child schema, so the walk has nothing to descend into. */
const LEAF_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'int',
  'boolean',
  'bigint',
  'symbol',
  'null',
  'undefined',
  'void',
  'never',
  'any',
  'unknown',
  'date',
  'nan',
  'literal',
  'enum',
  'file',
  'template_literal',
  'custom',
  'transform',
]);

/**
 * An object that does not refuse undeclared keys, and where it sits. `strip` drops them silently
 * (`def.catchall` is `undefined`); `loose` keeps them (a `z.looseObject`, whose catchall is
 * `unknown`). The path is joined as {@link describePath} writes it.
 */
export interface StripModeFinding {
  readonly path: string;
  readonly mode: 'strip' | 'loose';
}

/**
 * The path segment each descent adds. An object's key is the segment itself; the other kinds add
 * a fixed marker, so the path of an object inside a union's second option is `a(1)`.
 */
const ARRAY_ELEMENT = '[]';
const RECORD_VALUE = '{}';
const unionOption = (index: number): string => `(${index})`;

function definitionOf(schema: z.core.$ZodType): Definition {
  return (schema as unknown as { def: Definition }).def;
}

function describePath(segments: readonly string[]): string {
  return segments.reduce(
    (path, segment) =>
      path === ''
        ? segment
        : segment === ARRAY_ELEMENT || segment.startsWith('(')
          ? path + segment
          : `${path}.${segment}`,
    '',
  );
}

/**
 * Every nested object under `root` that does not refuse undeclared keys, in discovery order. `root` itself is
 * excluded, because `unknownKeyPolicy` governs it. A visited set ends a self-referencing schema
 * such as `z.json()`. A Zod type that has children this walk does not know throws, so a schema kind
 * added later fails the guard instead of being skipped.
 */
export function findStripModeObjects(root: z.core.$ZodType): StripModeFinding[] {
  const findings: StripModeFinding[] = [];
  const visited = new Set<z.core.$ZodType>();

  const visit = (schema: z.core.$ZodType, segments: readonly string[], isRoot: boolean): void => {
    if (visited.has(schema)) return;
    visited.add(schema);
    const definition = definitionOf(schema);
    switch (definition.type) {
      case 'object': {
        const catchall = definition['catchall'] as z.core.$ZodType | undefined;
        if (!isRoot) {
          const catchallType = catchall === undefined ? undefined : definitionOf(catchall).type;
          if (catchall === undefined)
            findings.push({ path: describePath(segments), mode: 'strip' });
          else if (catchallType === 'unknown' || catchallType === 'any') {
            findings.push({ path: describePath(segments), mode: 'loose' });
          }
        }
        const shape = definition['shape'] as Record<string, z.core.$ZodType>;
        for (const [key, child] of Object.entries(shape)) visit(child, [...segments, key], false);
        if (catchall !== undefined) visit(catchall, [...segments, '*'], false);
        return;
      }
      case 'optional':
      case 'nullable':
      case 'default':
        visit(definition['innerType'] as z.core.$ZodType, segments, false);
        return;
      case 'array':
        visit(definition['element'] as z.core.$ZodType, [...segments, ARRAY_ELEMENT], false);
        return;
      case 'union': {
        // `z.discriminatedUnion` is a `union` with a `discriminator`, so one case covers both.
        const options = definition['options'] as readonly z.core.$ZodType[];
        options.forEach((option, index) => visit(option, [...segments, unionOption(index)], false));
        return;
      }
      case 'record':
        visit(definition['keyType'] as z.core.$ZodType, segments, false);
        visit(definition['valueType'] as z.core.$ZodType, [...segments, RECORD_VALUE], false);
        return;
      case 'intersection':
        visit(definition['left'] as z.core.$ZodType, segments, false);
        visit(definition['right'] as z.core.$ZodType, segments, false);
        return;
      case 'pipe':
        visit(definition['in'] as z.core.$ZodType, segments, false);
        visit(definition['out'] as z.core.$ZodType, segments, false);
        return;
      case 'lazy':
        visit((definition['getter'] as () => z.core.$ZodType)(), segments, false);
        return;
      default:
        if (LEAF_TYPES.has(definition.type)) return;
        throw new Error(
          `The strip-mode walk does not know the Zod type "${definition.type}" (at "${describePath(segments)}"). ` +
            'Teach findStripModeObjects to descend into it, or to treat it as a leaf, before it can hide a strip-mode object.',
        );
    }
  };

  visit(root, [], true);
  return findings;
}
