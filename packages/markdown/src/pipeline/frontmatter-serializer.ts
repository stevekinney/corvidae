import { sortKeys } from '../utilities/sort-keys.js';
import type { FrontMatterSerializeOptions } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Serialize front matter and body back to a complete Markdown document.
 *
 * @param data - Front matter data to serialize (null or empty object = no front matter)
 * @param body - Markdown body content
 * @param options - Serialization options
 * @returns Complete Markdown document with front matter (if data is non-empty)
 *
 * @example
 * ```ts
 * // With front matter
 * const doc = stringifyFrontMatter({ title: 'Hello' }, '# Content');
 * // => '---\ntitle: Hello\n---\n\n# Content'
 *
 * // Without front matter
 * const docNoMeta = stringifyFrontMatter(null, '# Content');
 * // => '# Content'
 * ```
 */
export function stringifyFrontMatter(
  data: Record<string, unknown> | null,
  body: string,
  options: FrontMatterSerializeOptions = {},
): string {
  const {
    preserveRaw = true,
    originalRaw,
    originalData,
    preserveEmptyFrontMatter = false,
  } = options;

  // If no data, handle based on preserveEmptyFrontMatter option
  if (!data || Object.keys(data).length === 0) {
    if (preserveEmptyFrontMatter) {
      // Preserve empty front matter block for documents that originally had it
      return `---\n---\n${body}`;
    }
    return body;
  }

  // Determine if we can preserve the original raw YAML
  let yamlContent: string;

  if (canPreserveRaw(preserveRaw, originalRaw, originalData, data)) {
    // Data unchanged, preserve original formatting
    yamlContent = originalRaw;
  } else {
    // Generate new YAML with deterministic key ordering
    yamlContent = serializeYaml(data);
  }

  // Combine front matter and body
  // The closing delimiter needs its own line ending, then body follows
  // This preserves blank lines between front matter and content
  return `---\n${yamlContent}\n---\n${body}`;
}

function canPreserveRaw(
  preserveRaw: boolean,
  originalRaw: string | null | undefined,
  originalData: Record<string, unknown> | null | undefined,
  data: Record<string, unknown>,
): originalRaw is string {
  return Boolean(preserveRaw && originalRaw && originalData && dataEquals(data, originalData));
}

/**
 * Serialize data to YAML with deterministic key ordering.
 * Keys are sorted alphabetically for consistent output.
 *
 * @param data - The data object to serialize
 * @returns The YAML string (without delimiters)
 *
 * @example
 * ```ts
 * const yaml = serializeYaml({ title: 'Hello', tags: ['a', 'b'] });
 * // "tags: [a, b]\ntitle: Hello"
 * ```
 */
export function serializeYaml(data: Record<string, unknown>): string {
  const lines: string[] = [];
  const sortedKeys = Object.keys(data).toSorted();

  for (const key of sortedKeys) {
    const value = data[key];
    lines.push(formatYamlLine(key, value));
  }

  return lines.join('\n');
}

/**
 * Format a single YAML key-value pair.
 * Handles common value types with appropriate formatting.
 */
function formatYamlLine(key: string, value: unknown): string {
  if (value === null || value === undefined) {
    return `${key}: null`;
  }

  if (typeof value === 'boolean' || typeof value === 'number') {
    return `${key}: ${value}`;
  }

  if (typeof value === 'string') {
    // Use quotes for strings that contain special characters or look like other types
    if (needsQuoting(value)) {
      return `${key}: "${escapeString(value)}"`;
    }
    return `${key}: ${value}`;
  }

  if (Array.isArray(value)) {
    const formatted = formatYamlArray(value);
    return `${key}:${formatted.startsWith('\n') ? formatted : ` ${formatted}`}`;
  }
  if (isRecord(value)) return `${key}:${formatYamlValue(value)}`;
  return `${key}: ${formatValue(value)}`;
}

function formatYamlValue(value: unknown): string {
  if (Array.isArray(value)) return formatYamlArray(value);
  if (isRecord(value)) return `\n${serializeNestedObject(value, 2)}`;
  return formatValue(value);
}

function formatYamlArray(value: unknown[]): string {
  if (value.length === 0) return '[]';
  if (value.every((item) => typeof item === 'string' && !needsQuoting(item))) {
    return `[${value.join(', ')}]`;
  }
  return `\n${value.map((item) => `  - ${formatValue(item)}`).join('\n')}`;
}

/**
 * Serialize a nested object with indentation.
 */
function serializeNestedObject(obj: Record<string, unknown>, indent: number): string {
  const spaces = ' '.repeat(indent);
  const lines: string[] = [];
  const sortedKeys = Object.keys(obj).toSorted();

  for (const key of sortedKeys) {
    const value = obj[key];
    if (isRecord(value)) {
      lines.push(`${spaces}${key}:`);
      lines.push(serializeNestedObject(value, indent + 2));
    } else {
      lines.push(`${spaces}${key}: ${formatValue(value)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a value for inline use in YAML.
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    if (needsQuoting(value)) {
      return `"${escapeString(value)}"`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return `[${value.map(formatValue).join(', ')}]`;
  }
  if (isRecord(value)) {
    // Serialize objects in YAML flow style: {key: value, key2: value2}
    const pairs = Object.keys(value)
      .toSorted()
      .map((k) => `${k}: ${formatValue(value[k])}`);
    return `{${pairs.join(', ')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

/**
 * Check if a string value needs quoting in YAML.
 */
function needsQuoting(value: string): boolean {
  // Empty string
  if (value === '') return true;

  // Looks like a number or boolean
  if (/^[-+]?\d*\.?\d+$/.test(value)) return true;
  if (['true', 'false', 'yes', 'no', 'on', 'off', 'null'].includes(value.toLowerCase()))
    return true;

  // Contains special characters
  if (/[:#[\]{}|>&*!?,\\"]/.test(value)) return true;

  // Starts with special characters
  if (/^[@`']/.test(value)) return true;

  // Contains newlines
  if (value.includes('\n')) return true;

  return false;
}

/**
 * Escape special characters in a string for YAML double-quoted strings.
 */
function escapeString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Deep equality check for front matter data.
 * Used to determine if original raw YAML can be preserved.
 */
function dataEquals(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
