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
 * The sentence an approval policy writes as its reason (`armorer`'s `approvalStatusToDecision`):
 * `Tool "bureau:discover-agents" (read-only tier) requires approval (mode: always).`, or the same
 * tool "is denied by approval policy". It says why a person is asked, never what the call does.
 */
const POLICY_REASON =
  /^Tool "[^"]+" \([\w-]+ tier\) (?:requires approval|is denied by approval policy) \(mode: [\w-]+\)[.?]?$/;

/** Whether `text` is an approval policy's reason sentence rather than words a tool wrote. */
export function isPolicyReason(text: string | undefined): boolean {
  return text !== undefined && POLICY_REASON.test(text.trim());
}

/**
 * What a tool declared to say about one call, or `undefined`. Approvals carry a policy's reason,
 * and the Bureau sends that reason as the message when the tool wrote none (`ag-ui-interrupts.ts`),
 * so a message that is one of the `reasons` again, or that is a policy's reason sentence at all,
 * is not a summary. The second test is the one that holds when the row that would carry the reason
 * says something else or has not been read (COR-2438: the reason is never the title).
 */
export function declaredSummary(
  message: string | undefined,
  ...reasons: readonly (string | undefined)[]
): string | undefined {
  if (message === undefined || message.trim() === '') return undefined;
  if (isPolicyReason(message)) return undefined;
  const said = message.trim();
  return reasons.some((reason) => reason?.trim() === said) ? undefined : said;
}

/**
 * The policy's reason for an approval: the first of `candidates` that is a policy's reason
 * sentence, else the first one given. The Bureau's review carries the reason itself; the row a
 * parked call shows, and the approval's message for a tool that wrote no summary, carry it too, so
 * whichever of them a page has read says the mode.
 */
export function policyReasonOf(...candidates: readonly (string | undefined)[]): string | undefined {
  return (
    candidates.find((candidate) => isPolicyReason(candidate)) ??
    candidates.find((candidate) => candidate !== undefined && candidate.trim() !== '')
  );
}

/**
 * Whether the policy's reason for an approval says the tool is set to Always, which asks on every
 * call: "Tool "issue-refund" (dangerous tier) requires approval (mode: always)." That sentence is
 * where the Bureau says the mode today, so reading it is how a page learns that allowing the tool
 * for the rest of the chat would change nothing (the grant never loosens an Always tool).
 */
export function reasonSaysAlways(reason: string | undefined): boolean {
  return reason !== undefined && /\(mode: always\)/.test(reason);
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
