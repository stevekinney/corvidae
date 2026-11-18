import { tick } from 'svelte';

import {
  formatDateTime,
  formatTimeOfDay,
  formatTimeZoneLabel,
} from '../../utilities/format-date.ts';
import { humanizeIdentifier } from '../../utilities/humanize-identifier.ts';
import { readPayloadEntries } from '../payload-inspector/payload-inspector-fields.ts';
import { describeContents, describeScalar } from '../payload-inspector/payload-inspector-model.ts';
import {
  isSecretValue,
  maskSecrets,
  SECRET_MASK,
} from '../payload-inspector/payload-inspector-secrets.ts';
import type { StatusDotStatus } from '../status-dot/status-dot.types.ts';
import type { ApprovalState, ApprovalToolRisk } from './approval-card.types.ts';

/** Character budget for the serialized arguments preview before truncation. */
export const ARGUMENTS_PREVIEW_MAX_CHARACTERS = 4_096;

/** Visible label for each risk level. */
export const RISK_LABELS = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
} as const satisfies Record<ApprovalToolRisk, string>;

/** The risk word written beside the tool, in muted regular text. The glyph carries the alert. */
export const RISK_WORDS = {
  low: 'Reads',
  medium: 'Changes things',
  high: 'Dangerous',
} as const satisfies Record<ApprovalToolRisk, string>;

/** Visible label for each approval state. */
export const STATE_LABELS = {
  pending: 'Pending',
  approved: 'Approved',
  approved_with_edits: 'Approved with edits',
  denied: 'Denied',
  expired: 'Expired',
  cancelled: 'Cancelled',
  unavailable: 'Unavailable',
} as const satisfies Record<ApprovalState, string>;

/** StatusDot status for each approval state. */
export const STATE_DOT_STATUS = {
  pending: 'pending',
  approved: 'success',
  approved_with_edits: 'success',
  denied: 'danger',
  expired: 'neutral',
  cancelled: 'offline',
  unavailable: 'neutral',
} as const satisfies Record<ApprovalState, StatusDotStatus>;

/**
 * Resolves the state shown to the approver: a pending approval whose
 * expiration timestamp has passed presents as expired.
 */
export function resolveEffectiveApprovalState(
  approvalState: ApprovalState,
  expirationTimestamp: number | undefined,
  currentTime: number | undefined,
): ApprovalState {
  if (approvalState !== 'pending' || expirationTimestamp === undefined) return approvalState;
  return resolveComparisonTime(currentTime) >= expirationTimestamp ? 'expired' : approvalState;
}

/** Whether approval actions may still be taken on the request. */
export function isApprovalActionable(
  approvalState: ApprovalState,
  expirationTimestamp: number | undefined,
  currentTime: number | undefined,
): boolean {
  if (approvalState !== 'pending') return false;
  if (expirationTimestamp === undefined) return true;
  return resolveComparisonTime(currentTime) < expirationTimestamp;
}

function resolveComparisonTime(currentTime: number | undefined): number {
  return currentTime ?? Date.now();
}

/**
 * Says when an approval expired: "This approval expired at 10:15 AM CST, the time its request
 * set." The zone is the viewer's, so the time reads the way the viewer's clock does.
 */
export function describeExpiry(expirationTimestamp: number): string {
  const time = formatTimeOfDay(expirationTimestamp);
  const zone = formatTimeZoneLabel(expirationTimestamp);
  return `This approval expired at ${time}${zone === '' ? '' : ` ${zone}`}, the time its request set.`;
}

/** Parses an ISO expiration timestamp, returning undefined for invalid input. */
export function parseExpirationTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * What a decided approval was about, in the words of its action: the primary button's own label
 * (or the tool's label, or its humanized name) and the Target fact when there is one, such as
 * "Refund $42.00, order 4471". A decided card titles itself with this instead of repeating the
 * question it asked, which no longer reads as a question once it is answered. With neither a
 * named action nor a target the tool alone would say less than the question did, so the question's
 * words stay, as a statement: "Refund order 4398 for $27.25", never ending in a question mark once
 * the receipt's status ("Denied") has answered it (board row A4).
 */
export function describeDecidedAction(
  approveLabel: string | undefined,
  tool: { name: string; label?: string | undefined },
  facts: readonly { label: string; value: string }[],
  question: string,
): string {
  const target = facts.find((fact) => fact.label.trim().toLowerCase() === 'target')?.value.trim();
  const hasTarget = target !== undefined && target !== '';
  if (approveLabel === undefined && !hasTarget) return question.replace(/[\s?？]+$/u, '');
  const action =
    approveLabel ?? tool.label ?? humanizeIdentifier(tool.name, { casing: 'sentence' });
  return hasTarget ? `${action}, ${target}` : action;
}

/**
 * True when every field of the input summary is already shown in the open as a fact (a Command,
 * a Target, the tool), so input rows would only repeat it: "Input: Command refund order
 * 4471" under the Command fact that already reads "refund order 4471".
 */
export function inputRepeatsShownFacts(
  pairs: readonly InputSummaryPair[],
  shownValues: readonly (string | undefined)[],
): boolean {
  const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
  const shown = new Set(
    shownValues.filter((value): value is string => value !== undefined).map(squash),
  );
  return pairs.length > 0 && pairs.every((pair) => !pair.muted && shown.has(squash(pair.text)));
}

/** The title of a decided approval that never got a decision: "Expired before a decision: …". */
export const UNDECIDED_PREFIX: Partial<Record<ApprovalState, string>> = {
  expired: 'Expired before a decision',
  cancelled: 'Cancelled before a decision',
};

const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 24 * HOUR_SECONDS;

/**
 * Formats a millisecond duration as a compact countdown: `3 h` from an hour up, `4m 10s` under
 * an hour, `45s` under a minute. Whole hours, rounded down, so it never promises more time than
 * is left.
 */
export function formatRemainingTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / HOUR_SECONDS);
  const minutes = Math.floor((totalSeconds % HOUR_SECONDS) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours} h`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * The countdown line of a pending approval. More than a day out it names the deadline ("Expires
 * Nov 12, 9:30 AM" or "Expires Tomorrow, 9:30 AM"), because an hour count with no upper bound
 * read "Expires in 8521807 h"; closer than that it counts down ("Expires in 3 h", "Expires in
 * 4m 10s").
 */
export function describeCountdown(expirationTimestamp: number, now: number): string {
  const remaining = expirationTimestamp - now;
  if (remaining > DAY_SECONDS * 1_000) {
    const when = formatDateTime(expirationTimestamp, { now });
    // "Tomorrow, 9:30 AM" starts a label; inside the sentence the day word is lower case.
    const inSentence = /^(Today|Tomorrow)\b/.test(when)
      ? `${when.charAt(0).toLowerCase()}${when.slice(1)}`
      : when;
    return `Expires ${inSentence}`;
  }
  return `Expires in ${formatRemainingTime(remaining)}`;
}

const WEEKDAY_PREFIX = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) /;

/**
 * The countdown as a narrow card writes it, so it shares one line with "Can't be undone" on a
 * phone: more than a day out it names only the day ("Expires Nov 17", "Expires tomorrow"); closer
 * than that it is the countdown itself, which is already short.
 */
export function describeCountdownShort(expirationTimestamp: number, now: number): string {
  const remaining = expirationTimestamp - now;
  if (remaining <= DAY_SECONDS * 1_000) return describeCountdown(expirationTimestamp, now);
  const when = formatDateTime(expirationTimestamp, { now });
  const separator = when.lastIndexOf(', ');
  const day = (separator < 0 ? when : when.slice(0, separator)).replace(WEEKDAY_PREFIX, '');
  const inSentence = /^(Today|Tomorrow)\b/.test(day)
    ? `${day.charAt(0).toLowerCase()}${day.slice(1)}`
    : day;
  return `Expires ${inSentence}`;
}

/**
 * Accepts serialized JSON strings as argument previews by parsing them into
 * their structured form; any other value passes through unchanged.
 */
export function normalizeArgumentsPreviewValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Bounds the arguments preview: values whose serialized form exceeds the
 * character budget are replaced with a truncation notice and an excerpt.
 */
export function prepareArgumentsPreview(value: unknown): { value: unknown; truncated: boolean } {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string' || serialized.length <= ARGUMENTS_PREVIEW_MAX_CHARACTERS) {
      // Pass the original value through unchanged — including strings.
      // PayloadInspector does its own parsing/display/copy handling for
      // strings; re-serializing here would hand it an already-quoted JSON
      // string, which displays unquoted but copies quoted (a mismatch).
      return { value, truncated: false };
    }
    return {
      value: {
        notice: 'Arguments preview truncated',
        originalCharacters: serialized.length,
        displayedCharacters: ARGUMENTS_PREVIEW_MAX_CHARACTERS,
        excerpt: serialized.slice(0, ARGUMENTS_PREVIEW_MAX_CHARACTERS),
      },
      truncated: true,
    };
  } catch {
    return { value, truncated: false };
  }
}

/** Serializes the arguments preview as the editable JSON seed text. */
export function formatEditableArguments(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized ?? 'null';
  } catch {
    return '{}';
  }
}

/** Parses editor text as JSON, returning a friendly error for invalid input. */
export function parseJsonText(
  text: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, message: 'Edited arguments must be valid JSON.' };
  }
}

/**
 * Reduces environment entries to unique variable names. Values accidentally
 * supplied as `NAME=value` are stripped so no secret material is rendered.
 */
export function sanitizeEnvironmentNames(names: string[]): string[] {
  const seen = new Set<string>();
  const sanitizedNames: string[] = [];

  for (const name of names) {
    const [firstPart] = name.split('=');
    const sanitizedName = firstPart?.trim() ?? '';
    if (!sanitizedName || seen.has(sanitizedName)) continue;
    seen.add(sanitizedName);
    sanitizedNames.push(sanitizedName);
  }

  return sanitizedNames;
}

/** Collapses duplicate file paths while preserving first-seen order. */
export function dedupeFilePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const uniquePaths: string[] = [];

  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    uniquePaths.push(path);
  }

  return uniquePaths;
}

/** The title over the touched files: "File touched" for one, "3 files touched" for more. */
export function describeFilesTouched(count: number): string {
  return count === 1 ? 'File touched' : `${count} files touched`;
}

/**
 * A path split into its directory segments and its file name. Each segment keeps the slash after
 * it, so the parts written side by side are the path exactly, and a line can break after any
 * slash. A path that ends in a slash, or has none, is all name.
 */
export function splitFilePath(path: string): { directorySegments: string[]; name: string } {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash < 0 || lastSlash === path.length - 1) return { directorySegments: [], name: path };
  const directorySegments = path
    .slice(0, lastSlash + 1)
    .split(/(?<=\/)/u)
    .filter((segment) => segment !== '');
  return { directorySegments, name: path.slice(lastSlash + 1) };
}

/**
 * Moves focus into the note field once "Add note" has opened it. The toggle that held focus is
 * gone by then, so without this the focus would fall back to the page.
 */
export async function focusOpenedNote(fieldId: string): Promise<void> {
  await tick();
  document.getElementById(fieldId)?.focus();
}

/** One pair of the input line: a sentence-case label and the value written as text. */
export type InputSummaryPair = {
  /**
   * The raw property name, such as `orderId`. Object keys are unique, so this is the stable
   * identity of a pair; distinct keys such as `orderId` and `order_id` humanize to one label.
   */
  key: string;
  /** The label, such as `Order ID`. */
  label: string;
  /** The value as text, such as `$42.00`. A hidden secret reads as its mask. */
  text: string;
  /** True when the value is a null or empty stand-in ("None", "Empty"), which reads muted. */
  muted: boolean;
};

/**
 * Reads the arguments preview as the pairs of one summary line, "Order ID 4471, Amount $42.00".
 * Only an object has pairs; a nested value counts its contents ("2 items") instead of spilling
 * onto the line, and a secret stays hidden. Anything else has no summary.
 */
export function summarizeInput(value: unknown): InputSummaryPair[] {
  const entries = readPayloadEntries(maskSecrets(normalizeArgumentsPreviewValue(value)));
  return entries.map((entry) => ({
    key: entry.key,
    label: humanizeIdentifier(entry.key, { casing: 'sentence' }),
    ...(entry.nested
      ? { text: describeContents(entry.value), muted: false }
      : describeScalarText(entry.value)),
  }));
}

/** A value that is not a list or an object as text: its mask when it is a secret, "None" or "Empty" muted. */
function describeScalarText(value: unknown): { text: string; muted: boolean } {
  const display = describeScalar(value);
  if (display.kind === 'secret') return { text: SECRET_MASK, muted: false };
  if (display.kind === 'none') return { text: 'None', muted: true };
  if (display.kind === 'empty') return { text: 'Empty', muted: true };
  return { text: display.text, muted: false };
}

/** One row of the input shown in the open: a label, then the whole value as text. */
export type InputRow = InputSummaryPair & {
  /** True when the value is a list or an object, written as compact JSON in the code font. */
  structured: boolean;
};

/**
 * How many rows of the input show before "Show all" offers the rest. The input had no count of
 * its own before; four keeps a short call (an order, an amount, a reason) whole.
 */
export const INPUT_SUMMARY_ROWS = 4;

/**
 * A value longer than this many characters takes the whole row of the input's grid: it would wrap
 * past about two lines in a 6.5rem column of small text.
 */
export const INPUT_WIDE_CHARACTERS = 28;

/**
 * Reads the arguments preview as the rows the approver reads in the open, one per field: "Order
 * ID" then "4471". Unlike the one-line summary, a nested value is written whole, as compact JSON
 * with any secret inside it masked, so nothing the call carries is out of reach. A preview that is
 * not a list or an object is one row labelled "Value"; an empty one has no rows.
 */
export function describeInputRows(value: unknown): InputRow[] {
  const masked = maskSecrets(normalizeArgumentsPreviewValue(value));
  const entries = readPayloadEntries(masked);
  if (entries.length === 0) {
    if (
      masked === undefined ||
      (typeof masked === 'object' &&
        masked !== null &&
        !(masked instanceof Date) &&
        !isSecretValue(masked))
    )
      return [];
    return [
      boundRow({ key: 'value', label: 'Value', ...describeScalarText(masked), structured: false }),
    ];
  }
  return entries.map((entry) =>
    boundRow({
      key: entry.key,
      label: humanizeIdentifier(entry.key, { casing: 'sentence' }),
      ...(entry.nested
        ? { text: writeCompactJson(entry.value), muted: false, structured: true }
        : { ...describeScalarText(entry.value), structured: false }),
    }),
  );
}

/** Cuts a value longer than the preview's character budget, so one huge value never floods the card. */
function boundRow(row: InputRow): InputRow {
  if (row.text.length <= ARGUMENTS_PREVIEW_MAX_CHARACTERS) return row;
  return { ...row, text: `${row.text.slice(0, ARGUMENTS_PREVIEW_MAX_CHARACTERS)}…` };
}

/** A list or an object as one line of JSON; a hidden secret writes its mask. */
function writeCompactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? describeContents(value);
  } catch {
    // A bigint or a cycle cannot be written as JSON; say how much there is instead.
    return describeContents(value);
  }
}

/**
 * When an approval was decided, as the Done detail writes it: the time of day, then the day. "10:33 AM today"
 * within the viewer's day, "4:12 PM yesterday" the day before, and "4:12 PM on Sun Nov 1" any other.
 *
 * @param decided The moment it was decided.
 * @param now The reference time; defaults to now.
 */
export function describeDecisionTime(decided: Date, now?: Date | number): string {
  // The day label comes from the shared date formatter, so a day the viewer calls "today" reads the same here.
  const label = formatDateTime(decided, { now });
  const separator = label.lastIndexOf(', ');
  const day = label.slice(0, separator);
  const time = label.slice(separator + 2);
  if (day === 'Today') return `${time} today`;
  if (day === 'Yesterday') return `${time} yesterday`;
  return `${time} on ${day}`;
}
