/**
 * What a finished agent tool call hands the plugin panel placed on it (COR-2214). Chat opens a
 * panel inline for any agent tool a plugin names, so it cannot know the shape of one tool's result;
 * what it can know is whether the call succeeded. The Bureau's tools answer with a `status`, and
 * `ok` is the only one that did the work: `invalid`, `conflict` (a proposal whose file changed
 * since it was made), `not-found` and `forbidden` are answers a person reads in the call's row and
 * panel, with no application to open over them. A result with no `status` is a plugin tool's own
 * and goes to the panel, which checks the shape of what it was sent for itself.
 */

/** The result as the panel receives it: serialized JSON of a plain object that did not fail, else `undefined`. */
export function panelResultText(result: unknown): string | undefined {
  const serialized = typeof result === 'string' ? result : JSON.stringify(result);
  if (serialized === undefined) return undefined;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const status: unknown = Reflect.get(parsed, 'status');
    return status === undefined || status === 'ok' ? serialized : undefined;
  } catch {
    return undefined;
  }
}
