import { humanizeIdentifier } from '../../utilities/humanize-identifier.ts';
import { stringify } from '../../utilities/stringify.ts';
import {
  isIdentifierField,
  readPayloadEntries,
} from '../payload-inspector/payload-inspector-fields.ts';
import { describeScalar } from '../payload-inspector/payload-inspector-model.ts';
import {
  containsSecret,
  isSecretValue,
  maskSecrets,
  writeSecretsAsText,
} from '../payload-inspector/payload-inspector-secrets.ts';

/** How one value of a payload reads in the panel's field list. */
export type PanelFieldKind = 'text' | 'number' | 'code' | 'none' | 'empty' | 'secret';

/** One labelled row of the panel's field list. */
export type PanelField = {
  /** The property name as stored. */
  key: string;
  /** The label: the key written as words, with acronyms kept ("orderId" reads "Order ID"). */
  label: string;
  /** The value as it reads, or the word that stands for a missing one ("None", "Empty", "Hidden"). */
  text: string;
  /** How the value is set: plain text, a number, small monospace for identifiers and objects, or a muted word. */
  kind: PanelFieldKind;
};

/** A payload prepared for the panel: its rows, its stored JSON, and the text a copy button writes. */
export type PanelPayload = {
  /** True when there is something to show. A missing payload, `null` aside, has no rows and no JSON. */
  present: boolean;
  /** The labelled rows of the Fields view. */
  fields: PanelField[];
  /** The text of the JSON view: the stored text when it holds no secret, else the masked value. */
  json: string;
  /** What Copy writes. Secrets are masked in it, as in both views. */
  copy: string;
};

function parseStoredText(value: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Writes a value as JSON text for the panel. A small flat object reads on one line, with spaces
 * inside the braces (`{ "orderId": "4471" }`); anything larger or nested is indented.
 */
export function formatJsonText(value: unknown): string {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value);
    const flat = entries.every(([, entry]) => typeof entry !== 'object' || entry === null);
    const line = `{ ${entries.map(([key, entry]) => `${JSON.stringify(key)}: ${JSON.stringify(entry)}`).join(', ')} }`;
    if (flat && entries.length > 0 && line.length <= 64) return line;
  }
  return stringify(value, 2);
}

/** A single value as JSON text. A bigint has no JSON form, so it reads as its digits. */
function scalarJson(value: unknown): string {
  return typeof value === 'bigint' ? value.toString() : (JSON.stringify(value) ?? '');
}

function describeField(key: string, value: unknown): PanelField {
  const label = humanizeIdentifier(key, { casing: 'sentence' });
  if (isSecretValue(value)) return { key, label, text: 'Hidden', kind: 'secret' };
  if (typeof value === 'object' && value !== null) {
    return { key, label, text: formatJsonText(writeSecretsAsText(value)), kind: 'code' };
  }
  const display = describeScalar(value);
  if (display.kind === 'none') return { key, label, text: 'None', kind: 'none' };
  if (display.kind === 'empty') return { key, label, text: 'Empty', kind: 'empty' };
  if (display.kind === 'secret') return { key, label, text: 'Hidden', kind: 'secret' };
  if (display.kind === 'number') return { key, label, text: display.text, kind: 'number' };
  return {
    key,
    label,
    text: display.text,
    kind: isIdentifierField(key, value) ? 'code' : 'text',
  };
}

/**
 * Prepares one payload for the panel. Text that is a JSON object or array is parsed for the Fields
 * view and shown as stored in the JSON view, unless it holds a secret, in which case the masked
 * value is written. Values the caller's secret paths name, or that read as secrets when none are
 * given, are masked before anything is laid out. An object lists its properties; any other value is
 * one "Value" row.
 */
export function readPanelPayload(value: unknown, redact?: readonly string[]): PanelPayload {
  if (value === undefined) return { present: false, fields: [], json: '', copy: '' };

  let source: unknown = value;
  let storedText: string | undefined;
  if (typeof value === 'string') {
    const parsed = parseStoredText(value);
    if (parsed.ok) {
      source = parsed.value;
      storedText = value;
    }
  }

  const masked = maskSecrets(source, redact);
  const text = writeSecretsAsText(masked);
  const isContainer = typeof text === 'object' && text !== null;
  const stored = storedText !== undefined && !containsSecret(masked) ? storedText : undefined;
  const json = stored ?? (isContainer ? formatJsonText(text) : scalarJson(text));
  const plain = isContainer && !Array.isArray(masked) && !isSecretValue(masked);
  const fields = plain
    ? readPayloadEntries(masked).map((entry) => describeField(entry.key, entry.value))
    : [{ ...describeField('value', masked), label: 'Value' }];
  return {
    present: true,
    fields,
    json,
    copy: typeof text === 'string' ? text : json,
  };
}
