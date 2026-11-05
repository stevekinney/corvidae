/**
 * What an agent is called where a person reads it (the bell, the search palette): the catalog's
 * display name, or the identifier where the catalog has none, and either one in words ("tool-runner"
 * reads "Tool runner") when it is only an identifier, as a code agent's display name is.
 */
import { humanizeIdentifier } from '@lostgradient/cinder';

import type { AgentSummary } from './bureau-client.ts';

/** A name written the way an identifier is: lower-case words joined by hyphens, underscores, dots or colons. */
const IDENTIFIER_SHAPED = /^[a-z0-9][a-z0-9:_.-]*$/;

/** The name an agent goes by for a person, given its identifier and the catalog (which may not be loaded). */
export function agentLabel(
  identifier: string,
  catalog: readonly Pick<AgentSummary, 'name' | 'displayName'>[] | undefined,
): string {
  const name = catalog?.find((agent) => agent.name === identifier)?.displayName ?? identifier;
  return IDENTIFIER_SHAPED.test(name) ? humanizeIdentifier(name, { casing: 'sentence' }) : name;
}
