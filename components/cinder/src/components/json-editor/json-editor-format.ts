/**
 * Pretty-print JSON source with two-space indentation.
 *
 * Returns `undefined` when the source is empty or is not valid JSON, so callers can disable the
 * Format action instead of reporting an error of their own. Parsing and re-serializing means
 * numbers outside the double-precision range lose digits and duplicate keys collapse; Format is
 * an explicit user action, never run implicitly.
 */
export function formatJson(source: string): string | undefined {
  if (source.trim() === '') return undefined;
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return undefined;
  }
}

/** Whether a JSON field holds no source at all, which an optional field treats as "Not set". */
export function isBlankJson(source: string): boolean {
  return source.trim() === '';
}
