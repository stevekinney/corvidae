import type { JSONValue } from '@corvidae/armorer';

function isJSONObject(value: unknown): value is Record<string, JSONValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(isJSONValue);
}

export function isJSONValue(value: unknown): value is JSONValue {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJSONValue);
  return isJSONObject(value);
}

export function toJSONValue(value: unknown): JSONValue {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  const parsed: unknown = JSON.parse(serialized);
  return isJSONValue(parsed) ? parsed : null;
}
