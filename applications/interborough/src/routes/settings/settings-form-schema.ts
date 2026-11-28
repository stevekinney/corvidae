/**
 * The JSON Schema a Cinder `SchemaForm` is given for an object-valued setting, a contributed
 * configuration or a workflow step's input: the node the Bureau or a plugin publishes, as it was
 * published. `SchemaForm` reads a union (an `anyOf` or a `oneOf`), a value that may be `null`, and
 * the unit of a duration on the field's own schema, and checks a value against the schema it was
 * given, so nothing here rewrites a keyword: a union stays the union it is, and a `null` or `false`
 * alternative stays an alternative. The row draws the node's description as Markdown itself, so the
 * form's copy is left out, and the form is titled by the key so its choice has the setting's name.
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The schema of the form for the setting `key`, whose published node is `node`. */
export function formSchemaOf(key: string, node: unknown): Json {
  const { description: _description, ...rest } = isRecord(node) ? node : {};
  return { ...rest, title: key };
}

/**
 * Whether every number field of `value` holds a committed number. A `SchemaForm` reports a field
 * that is still being typed in as its text (`onDraftChange`), so a string where `schema` calls for
 * a number is an edit that has not finished: it is neither checked nor sent. The number may be one
 * of a list of types (`["integer", "null"]`), and a union (an `anyOf` or a `oneOf`) holds its
 * fields in its alternatives.
 */
export function numbersCommitted(schema: unknown, value: unknown): boolean {
  if (!isRecord(schema)) return true;
  const types: unknown[] = [schema['type']].flat();
  if ((types.includes('number') || types.includes('integer')) && typeof value === 'string') {
    return false;
  }
  // A choice (`retention.events`: `'forever'` or `{ olderThan }`) holds its fields in its branches.
  for (const keyword of ['anyOf', 'oneOf']) {
    const branches = schema[keyword];
    if (Array.isArray(branches) && !branches.every((branch) => numbersCommitted(branch, value))) {
      return false;
    }
  }
  if (Array.isArray(value)) {
    return value.every((item) => numbersCommitted(schema['items'], item));
  }
  if (!isRecord(value)) return true;
  const properties = schema['properties'];
  if (!isRecord(properties)) return true;
  return Object.entries(value).every(([name, property]) =>
    Object.hasOwn(properties, name) ? numbersCommitted(properties[name], property) : true,
  );
}
