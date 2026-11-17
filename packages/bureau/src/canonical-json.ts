/**
 * JSON with object keys sorted and `undefined` members dropped, so two requests that list the same
 * configuration in another key order (an artifact, a budget, an identity) compare equal, and so a
 * definition's digest does not depend on how a file spelled it. Arrays keep their order: it is part
 * of the value.
 *
 * @module canonical-json
 */

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const members = Object.keys(value)
      .toSorted()
      .flatMap((key) => {
        const member: unknown = (value as Record<string, unknown>)[key];
        return member === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(member)}`];
      });
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
