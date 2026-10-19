/**
 * Who may see and manage the deployment's agents (COR-1526): one predicate, so every surface that
 * could disclose an agent the deployment has not published answers by the same rule.
 *
 * An agent file has no owner field, so every persisted agent belongs to the deployment's owner of
 * record, and the rule is the owner predicate's (`owner-predicate.ts`) over that owner: the owner
 * of the deployment's agents, or a caller holding the operator scope. An agent that is not
 * published is invisible to a caller who fails it, in the same words as one that does not exist.
 *
 * @module agent-access
 */

import type { Principal } from '@lostgradient/weft';

import { ownerOrLocal } from '../owner-of-record.ts';
import type { BureauScope } from './bureau-scopes.ts';
import type { BureauOwnershipHost } from './owner-predicate.ts';

/** The owner every agent belongs to, whether or not a directory is configured. */
export const DEPLOYMENT_AGENT_OWNER = ownerOrLocal(undefined);

/** Whether `principal` may use `operatorScope` on the deployment's agents. */
export function mayAccessAgents(
  ownership: BureauOwnershipHost['ownership'],
  principal: Principal,
  operatorScope: BureauScope,
): boolean {
  return ownership.mayAccess({
    principal,
    resourceOwner: DEPLOYMENT_AGENT_OWNER,
    operatorScope,
  });
}

/**
 * Whether `principal` may be told that an agent exists although the deployment does not publish
 * it: the rule `bureau.agents.definitions.list` applies. Every listing that names agents
 * filters by it, so an unpublished agent's name, label, and description reach only a caller who
 * could read its definition.
 */
export function mayDiscloseUnpublishedAgents(
  ownership: BureauOwnershipHost['ownership'],
  principal: Principal,
): boolean {
  return mayAccessAgents(ownership, principal, 'bureau.agents:read');
}
