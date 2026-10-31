/**
 * The JSON Schema a Cinder `SchemaForm` is given for an object-valued setting, made from the node
 * `bureau.settings.schema` publishes. The Bureau's schema is Zod's: a union is an `anyOf`, where
 * `SchemaForm` reads a `oneOf` (a segmented choice between a literal and an object); a duration is
 * a number named `olderThan`, where `SchemaForm` reads a unit from `format: 'duration-ms'` or a name
 * that ends in `Ms`. The row draws the node's description as Markdown itself, so the form's copy
 * is left out, and the form is titled by the key so its choice has the setting's name. A union with
 * `null` (`engine.payloadSize.maxBytes`, where `null` removes the limit) is drawn as the other
 * branch alone, a number field: `SchemaForm` has no control for `null`, and would draw the whole
 * field as JSON. A field cleared in the form is left out of the value, as it is left unset.
 */
import { isDuration } from './settings-controls.ts';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The branch a union holds beside `null`, or `undefined` for any other union. */
function withoutNull(branches: unknown): unknown {
  if (!Array.isArray(branches) || branches.length !== 2) return undefined;
  const [first, second] = branches;
  const isNull = (branch: unknown): boolean => isRecord(branch) && branch['type'] === 'null';
  if (isNull(first) !== isNull(second)) return isNull(first) ? second : first;
  return undefined;
}

function convert(node: unknown, name: string): unknown {
  if (Array.isArray(node)) return node.map((item) => convert(item, name));
  if (!isRecord(node)) return node;
  const optional = withoutNull(node['anyOf']);
  if (optional !== undefined) {
    const { anyOf: _union, ...rest } = node;
    return convert({ ...(isRecord(optional) ? optional : {}), ...rest }, name);
  }
  const converted: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isRecord(value)) {
      converted[key] = Object.fromEntries(
        Object.entries(value).map(([property, child]) => [property, convert(child, property)]),
      );
    } else {
      converted[key === 'anyOf' ? 'oneOf' : key] = convert(value, name);
    }
  }
  if (
    (converted['type'] === 'number' || converted['type'] === 'integer') &&
    isDuration(name) &&
    converted['format'] === undefined
  ) {
    converted['format'] = 'duration-ms';
  }
  return converted;
}

/** The schema of the form for the setting `key`, whose published node is `node`. */
export function formSchemaOf(key: string, node: unknown): Json {
  const converted = convert(node, key);
  const { description: _description, ...rest } = isRecord(converted) ? converted : {};
  return { ...rest, title: key };
}
