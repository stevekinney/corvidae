/**
 * What the Plugins page works out about a plugin's configuration around the form Cinder's
 * `SchemaForm` draws from the JSON Schema the plugin's own Zod schema writes
 * (`PluginStanding.configurationSchema`): which values the person changed, what to send, and which
 * field a refusal names. The form itself, with the control each field's shape calls for, is the
 * `setting-rows` variant of `SchemaForm`, so a plugin that adds a field gets a row with no change here.
 */
import { isSameJson } from '../../../lib/contributed-configuration.ts';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The fields whose value in `draft` is not the one the form started with. The form seeds the
 * values a schema shows by default (an enum's first option, a switch off, an empty list), so a
 * draft holds fields the person never touched, and only these differ from what it started with.
 */
export function configurationChanges(initial: unknown, draft: unknown): Json {
  const before = isRecord(initial) ? initial : {};
  const after = isRecord(draft) ? draft : {};
  const changes: Json = {};
  const read = (from: Json, key: string): unknown =>
    Object.hasOwn(from, key) ? from[key] : undefined;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!isSameJson(read(before, key), read(after, key))) changes[key] = read(after, key);
  }
  return changes;
}

/** Whether the configuration schema declares a property of this name, so a refusal can name its row. */
export function hasConfigurationField(
  schema: Readonly<Record<string, unknown>> | null,
  key: string,
): boolean {
  const properties = schema?.['properties'];
  return isRecord(properties) && Object.hasOwn(properties, key);
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
