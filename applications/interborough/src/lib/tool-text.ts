/**
 * The words a person reads for a tool call: the question an approval asks, what a call was given,
 * and what it answered. A tool that declares a `summary` (`armorer`'s `metadata.summary`) has the
 * Bureau write the call into it, and the result arrives as the approval's `message`. A tool that
 * does not leaves `message` equal to the policy's reason, which is no help to anyone deciding, so
 * the question is made from the call's own name and arguments instead.
 */

const LONGEST_SUMMARY = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value as one short piece of text: strings as they are, everything else as compact JSON. */
export function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value) ?? '';
}

/** `text` cut to `limit` characters with an ellipsis, on one line. */
export function shorten(text: string, limit: number = LONGEST_SUMMARY): string {
  const single = text.replaceAll(/\s+/g, ' ').trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1).trimEnd()}…`;
}

/** The keys and values of a call's arguments, in the order the tool took them. */
export function argumentEntries(args: unknown): readonly (readonly [string, string])[] {
  if (!isRecord(args))
    return args === undefined || args === null ? [] : [['value', displayValue(args)]];
  return Object.entries(args).map(([key, value]) => [key, displayValue(value)] as const);
}

/** `orderId order-1001, cents 4200` for a call's arguments. */
export function argumentLine(args: unknown): string {
  return argumentEntries(args)
    .map(([key, value]) => `${key} ${value}`)
    .join(', ');
}

/**
 * What a tool declared to say about one call, or `undefined`. Approvals carry a policy's reason
 * and a message that is the reason again unless the tool wrote its own, so a message equal to the
 * reason is not a summary.
 */
export function declaredSummary(
  message: string | undefined,
  reason: string | undefined,
): string | undefined {
  if (message === undefined || message.trim() === '') return undefined;
  return message === reason ? undefined : message.trim();
}

/**
 * The question an approval asks: the tool's own sentence when it wrote one, else the tool and its
 * arguments. Always ends in a question mark.
 */
export function approvalQuestion(input: {
  readonly toolName: string;
  readonly arguments: unknown;
  readonly summary: string | undefined;
}): string {
  if (input.summary !== undefined) return `${input.summary.replace(/[?.]+$/, '')}?`;
  const line = argumentLine(input.arguments);
  return line === '' ? `Run ${input.toolName}?` : `Run ${input.toolName} with ${line}?`;
}

/** One line for what a tool answered: its text, or its fields, cut short. */
export function resultSummary(content: unknown): string {
  if (typeof content === 'string') return shorten(content);
  if (isRecord(content)) {
    const fields = argumentLine(content);
    return fields === '' ? '' : shorten(fields);
  }
  return content === null || content === undefined ? '' : shorten(displayValue(content));
}
