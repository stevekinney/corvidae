/**
 * The check an agent source makes on a reference path before it reads (COR-1866): the same rule
 * the agent file's `references` key is parsed with, applied again at the source boundary so a
 * caller that does not go through a file cannot read outside the source's own location.
 *
 * @module reference-path
 */

import { AGENT_REFERENCE_SIZE_LIMIT, agentReferencePathProblem } from '../agent-file';

/** Throws a `TypeError` naming the path when it cannot be a reference path. */
export function assertReferencePath(path: unknown): asserts path is string {
  if (typeof path !== 'string') throw new TypeError('A reference path must be a string.');
  const problem = agentReferencePathProblem(path);
  if (problem !== undefined) {
    throw new TypeError(`The reference path ${JSON.stringify(path)} ${problem}.`);
  }
}

const textDecoder = new TextDecoder('utf-8', { fatal: true });

/** Refuse bytes that cannot become one supported reference document before a source writes them. */
export function assertReferenceDocument(bytes: Uint8Array): void {
  if (bytes.byteLength > AGENT_REFERENCE_SIZE_LIMIT) {
    throw new RangeError(
      `A reference document may be at most ${String(AGENT_REFERENCE_SIZE_LIMIT)} bytes.`,
    );
  }
  try {
    textDecoder.decode(bytes);
  } catch {
    throw new TypeError('A reference document must be valid UTF-8 text.');
  }
}
