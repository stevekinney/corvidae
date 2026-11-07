/**
 * The configuration form of a plugin, worked out from the JSON Schema its own Zod schema writes
 * (`PluginStanding.configurationSchema`): which fields there are, the control each calls for, and
 * the words for it. The page draws the form from the schema, never as raw JSON, so a plugin that
 * adds a field gets a control with no change here; only a field whose shape no control reads (an
 * object, or an array of objects) falls back to a JSON editor of its own.
 */
type Json = Record<string, unknown>;

/** The control a field is edited with. */
export type FieldControl =
  | { readonly kind: 'text' }
  | { readonly kind: 'select'; readonly options: readonly string[] }
  | { readonly kind: 'switch' }
  | { readonly kind: 'number' }
  | { readonly kind: 'duration' }
  | { readonly kind: 'tags' }
  | { readonly kind: 'json' };

/** One field of a plugin's configuration. */
export type ConfigurationField = {
  /** The key in the configuration, shown small and monospaced beside the label. */
  readonly key: string;
  /** The name as a person reads it: the schema's title, else the key as words. */
  readonly label: string;
  /** The schema's description, or an empty string. */
  readonly description: string;
  /** Whether the configuration must hold the field. */
  readonly required: boolean;
  readonly control: FieldControl;
  /** The value the plugin uses when the configuration does not hold the field, if its schema names one. */
  readonly defaultValue: unknown;
};

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What a nullable field is besides `null`: a type list (`["string","null"]`) is its other type, and
 * a union (`anyOf`) is its other branch. Any other node is itself.
 */
function withoutNull(node: Json): Json {
  const types = node['type'];
  if (Array.isArray(types)) {
    const rest = types.filter((type) => type !== 'null');
    const [only] = rest;
    return rest.length === 1 ? { ...node, type: only } : node;
  }
  const branches = node['anyOf'];
  if (!Array.isArray(branches)) return node;
  const rest = branches.filter((branch) => !(isRecord(branch) && branch['type'] === 'null'));
  const [only] = rest;
  const { anyOf: _union, ...own } = node;
  return rest.length === 1 && isRecord(only) ? { ...only, ...own } : node;
}

/** `blockedSites` or `blocked-sites` as words, `Blocked sites`. */
export function fieldWords(key: string): string {
  const spaced = key
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/[-_.]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced === '' ? key : `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

function controlOf(key: string, node: Json): FieldControl {
  const type = node['type'];
  const enumeration = node['enum'];
  if (
    type === 'string' &&
    Array.isArray(enumeration) &&
    enumeration.every((entry) => typeof entry === 'string')
  ) {
    return { kind: 'select', options: enumeration };
  }
  if (type === 'string') return { kind: 'text' };
  if (type === 'boolean') return { kind: 'switch' };
  if (type === 'number' || type === 'integer') {
    return node['format'] === 'duration-ms' || /Ms$|Milliseconds$/.test(key)
      ? { kind: 'duration' }
      : { kind: 'number' };
  }
  const items = node['items'];
  if (type === 'array' && isRecord(items) && items['type'] === 'string') return { kind: 'tags' };
  return { kind: 'json' };
}

/**
 * The fields of a configuration schema, in the order the schema declares them. A schema that is
 * not an object with properties has none, and the page draws no form for it.
 */
export function configurationFields(
  schema: Readonly<Record<string, unknown>> | null,
): readonly ConfigurationField[] {
  if (schema === null || !isRecord(schema['properties'])) return [];
  const required = Array.isArray(schema['required']) ? schema['required'] : [];
  return Object.entries(schema['properties']).map(([key, raw]) => {
    const node = isRecord(raw) ? withoutNull(raw) : {};
    const title = node['title'];
    const description = node['description'];
    return {
      key,
      label: typeof title === 'string' && title !== '' ? title : fieldWords(key),
      description: typeof description === 'string' ? description : '',
      required: required.includes(key),
      control: controlOf(key, node),
      defaultValue: node['default'],
    };
  });
}

/**
 * The configuration to send: the values the person left in the form, without a field cleared to
 * nothing (an empty text, a cleared number), which is left unset as the schema allows.
 */
export function configurationToSave(draft: Readonly<Record<string, unknown>>): Json {
  return Object.fromEntries(
    Object.entries(draft).filter(([, value]) => value !== undefined && value !== ''),
  );
}

/**
 * The field a refusal names and what it says: the host words the field as
 * `configuration.<key>.<path>`, so the first segment after `configuration` is the form's field.
 * Anything else (or no field at all) is not about one field.
 */
export function refusedField(field: string | undefined): string | undefined {
  if (field === undefined || !field.startsWith('configuration.')) return undefined;
  const [key] = field.slice('configuration.'.length).split('.');
  return key === undefined || key === '' ? undefined : key;
}

/** The text a field's control shows for a value held as JSON (the fallback editor). */
export function jsonText(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

/** Reads the fallback editor's text back: the value, or `undefined` for an empty editor, or `'invalid'`. */
export function parseJsonField(text: string): { readonly value: unknown } | 'invalid' {
  if (text.trim() === '') return { value: undefined };
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return 'invalid';
  }
}
