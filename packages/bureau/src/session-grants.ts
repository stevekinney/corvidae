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
import { parseToolId, toNamespacedToolName } from 'armorer';

/**
 * The name a provider calls the tool `identifier` names by (`toNamespacedToolName`), whatever form
 * it comes in: a grant's id (`shop:issue-refund@1.0.0`, `default:issue-refund@1.0.0`), the name an
 * unsigned grant or a result reports (`shop:issue-refund`, `issue-refund`), or the provider's own
 * name a stored call carries (`shop__issue-refund`). The version is not part of it, so every
 * version of a tool has the one name, and two namespaces' tools of one name have two.
 */
function providerNameOf(identifier: string): string {
  try {
    return toNamespacedToolName(parseToolId(identifier));
  } catch {
    return identifier;
  }
}

/**
 * `metadata` without the grants of `tools`, with the grants forgotten as they were stored. A grant
 * is stored under the tool's identifier (`namespace:name@version`), and a tool is named as a call
 * carries it, often the provider's `namespace__name`: both are read as the name a provider calls
 * the tool by, so a name matches the grants of every version of its tool and of no other tool. A
 * name no grant matches changes nothing: the same `metadata` comes back. The `approvalGrants`
 * entry is dropped once it holds no grant.
 */
export function withoutGrantsFor(
  metadata: AgentSession['metadata'],
  tools: readonly string[],
): { readonly metadata: AgentSession['metadata']; readonly forgotten: readonly string[] } {
  const held = metadata['approvalGrants'];
  const grants = Array.isArray(held)
    ? held.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const named = new Set(tools.map(providerNameOf));
  const forgotten = grants.filter((grant) => named.has(providerNameOf(grant)));
  if (forgotten.length === 0) return { metadata, forgotten };
  const { approvalGrants: _replaced, ...rest } = metadata;
  const kept = grants.filter((grant) => !forgotten.includes(grant));
  return { metadata: kept.length === 0 ? rest : { ...rest, approvalGrants: kept }, forgotten };
}
