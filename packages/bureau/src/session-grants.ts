/**
 * Forgetting a chat's "Allow for the rest of this chat" grants (B06, row 20c). Retry on a reply
 * that failed runs the turn again over a thread that still holds the failed attempt, so a tool
 * that changes things and was interrupted must go back through its approval rather than run a
 * second time on the strength of a grant given before. Only the grants change: no row of the
 * conversation is touched.
 *
 * @module session-grants
 */

import type { AgentSession } from '@lostgradient/operative';

/** The name of a tool as a grant or a call carries it: `namespace:name@version` reads `name`. */
function toolNameOf(identifier: string): string {
  const unversioned = identifier.split('@')[0] ?? identifier;
  return unversioned.slice(unversioned.lastIndexOf(':') + 1);
}

/** Whether a grant stored under `grant` allows the tool a call names as `name`. */
function grantAllows(grant: string, name: string): boolean {
  return grant === name || toolNameOf(grant) === toolNameOf(name);
}

/**
 * `metadata` without the grants of `tools`, with the grants forgotten as they were stored. A grant
 * is stored under the tool's identifier (`namespace:name@version`), so a name matches the grants
 * of every version of the tool, and a name no grant matches changes nothing: the same `metadata`
 * comes back. The `approvalGrants` entry is dropped once it holds no grant.
 */
export function withoutGrantsFor(
  metadata: AgentSession['metadata'],
  tools: readonly string[],
): { readonly metadata: AgentSession['metadata']; readonly forgotten: readonly string[] } {
  const held = metadata['approvalGrants'];
  const grants = Array.isArray(held)
    ? held.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const forgotten = grants.filter((grant) => tools.some((name) => grantAllows(grant, name)));
  if (forgotten.length === 0) return { metadata, forgotten };
  const { approvalGrants: _replaced, ...rest } = metadata;
  const kept = grants.filter((grant) => !forgotten.includes(grant));
  return { metadata: kept.length === 0 ? rest : { ...rest, approvalGrants: kept }, forgotten };
}
