import {
  formatDateTime,
  formatTimeOfDay,
  formatTimeZoneLabel,
} from '../../utilities/format-date.ts';
import { humanizeIdentifier } from '../../utilities/humanize-identifier.ts';
import { readPayloadEntries } from '../payload-inspector/payload-inspector-fields.ts';
import { describeContents, describeScalar } from '../payload-inspector/payload-inspector-model.ts';
import { maskSecrets, SECRET_MASK } from '../payload-inspector/payload-inspector-secrets.ts';
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

/** Formats a millisecond duration as a compact countdown such as `2h 5m` or `45s`. */
export function formatRemainingTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
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
 * Reads the arguments preview as the pairs of one summary line, "Order ID 4471 · Amount $42.00".
 * Only an object has pairs; a nested value counts its contents ("2 items") instead of spilling
 * onto the line, and a secret stays hidden. Anything else has no summary.
 */
export function summarizeInput(value: unknown): InputSummaryPair[] {
  const entries = readPayloadEntries(maskSecrets(normalizeArgumentsPreviewValue(value)));
  const pairs: InputSummaryPair[] = [];
  for (const entry of entries) {
    const label = humanizeIdentifier(entry.key, { casing: 'sentence' });
    if (entry.nested) {
      pairs.push({ key: entry.key, label, text: describeContents(entry.value), muted: false });
      continue;
    }
    const display = describeScalar(entry.value);
    if (display.kind === 'secret')
      pairs.push({ key: entry.key, label, text: SECRET_MASK, muted: false });
    else if (display.kind === 'none')
      pairs.push({ key: entry.key, label, text: 'None', muted: true });
    else if (display.kind === 'empty')
      pairs.push({ key: entry.key, label, text: 'Empty', muted: true });
    else pairs.push({ key: entry.key, label, text: display.text, muted: false });
  }
  return pairs;
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
