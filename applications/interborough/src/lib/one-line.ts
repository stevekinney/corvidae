/**
 * What a failed run said, in the few words a row has room for. Shared by the Runs list and
 * Schedules, so a row never prints an error's JSON.
 */

/** The `message` of an error object, or of the `cause` it names, when it has one. */
function messageOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const cause: unknown = Reflect.get(value, 'cause');
  const inner = messageOf(cause);
  if (inner !== undefined) return inner;
  const message: unknown = Reflect.get(value, 'message');
  return typeof message === 'string' && message !== '' ? message : undefined;
}

/** What {@link oneLine} keeps. */
export type OneLineOptions = {
  /** Keep the detail in parentheses at the end: "GitHub didn’t answer (HTTP 503)". */
  readonly keepParenthetical?: boolean;
};

/**
 * What a failed run said, in the few words a row has room for: the cause an agent run wraps in its
 * own message (`Agent "assistant" failed (…): {"cause":{"message":"GitHub didn’t answer (HTTP
 * 503)"}}`), without the name of the error class in front of it or, unless `keepParenthetical`,
 * the detail in parentheses behind it ("GitHub didn’t answer"). The run's own page says all of it.
 */
export function oneLine(message: string, options: OneLineOptions = {}): string {
  const braces = message.indexOf('{');
  let said = message;
  if (braces >= 0) {
    try {
      said = messageOf(JSON.parse(message.slice(braces))) ?? message.slice(0, braces);
    } catch {
      // What follows the brace is not JSON, so the message is read as it stands.
    }
  }
  const first = said.split('\n').find((line) => line.trim() !== '') ?? '';
  const named = first.replace(/^\s*[A-Za-z]*Error:\s*/, '');
  return (
    options.keepParenthetical === true ? named : named.replace(/\s*\([^()]*\)\s*$/, '')
  ).trim();
}
