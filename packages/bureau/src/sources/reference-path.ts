/**
 * The check an agent source makes on a reference path before it reads (COR-1866): the same rule
 * the agent file's `references` key is parsed with, applied again at the source boundary so a
 * caller that does not go through a file cannot read outside the source's own location.
 *
 * @module reference-path
 */

import { agentReferencePathProblem } from '../agent-file';

/** Throws a `TypeError` naming the path when it cannot be a reference path. */
export function assertReferencePath(path: unknown): asserts path is string {
  if (typeof path !== 'string') throw new TypeError('A reference path must be a string.');
  const problem = agentReferencePathProblem(path);
  if (problem !== undefined) {
    throw new TypeError(`The reference path ${JSON.stringify(path)} ${problem}.`);
  }
}
