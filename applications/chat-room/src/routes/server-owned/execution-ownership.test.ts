import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Who owns execution is a DECLARED property of each route's controller, and
 * this file pins the declaration.
 *
 * The runtime behaviour it declares is already covered where it belongs, in
 * `@corvidae/chat`'s `session-controller-execution-owner.test.ts`: a
 * server-owned controller submits exactly once after tools resolve, and one
 * without the option submits again. What no runtime test in this application
 * can observe is which of the two THIS route asked for, because the difference
 * is that the transport is never invoked a second time — an absence leaves
 * nothing for a browser spec to see.
 *
 * So it is asserted against the source, the same way this application already
 * pins its toolbox ownership and its provider-SDK boundary. Bun's normal test
 * discovery includes this file.
 */

const routesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath: string): string {
  return readFileSync(resolve(routesRoot, relativePath), 'utf8');
}

const serverOwnedSurface = read('server-owned/[id]/conversation-surface.svelte');
const browserOwnedPage = read('+page.svelte');

describe('execution ownership is declared, not inferred', () => {
  /**
   * The server-owned family runs every step of a turn inside one response, so
   * a continuation would either duplicate the turn or ask the host for a step
   * it has nothing to answer with. `executionOwner: 'server'` says that once,
   * about the submission.
   */
  it('the server-owned surface declares the server as the execution owner', () => {
    expect(serverOwnedSurface).toContain("executionOwner: 'server'");
  });

  /**
   * What the declaration REPLACED, and why its removal is part of the same
   * property rather than tidying afterwards.
   *
   * Before the option existed, this transport defended itself by reading the
   * last message off the history it was handed and returning an empty stream
   * unless that message was user text. It worked, but it made one-submission
   * behaviour a consequence of inspecting a turn's contents: every continuation
   * still cost an appended-then-cancelled assistant row and two history
   * revisions, and the route's correctness depended on a role check that a
   * differently-shaped turn could have answered the other way.
   *
   * `shouldStopAfterTurn` consults the execution owner FIRST and nothing else,
   * so with the declaration in place the controller never reaches the transport
   * a second time. Reinstating the empty stream alongside it would put the
   * inference back and quietly make the declaration decorative — and would go
   * on absorbing, as a normal outcome, a call that can now only be a wiring
   * mistake.
   *
   * The transport still reads the trailing user message, because that text is
   * what it sends. What it must not carry is a branch answering a continuation
   * with an empty stream.
   */
  it('the server-owned transport answers no continuation with an empty stream', () => {
    expect(serverOwnedSurface).not.toMatch(/return\s*\(async function\*\s*\(\)\s*\{\s*\}\)\(\)/);
  });

  /**
   * The browser-owned route drives the next step itself, which is what the
   * default already means. Setting the option there would either be a no-op
   * spelled out at length or, set wrongly, would truncate a turn that still
   * owes the host a step — so the absence is the assertion.
   */
  it('the browser-owned page leaves execution ownership at its default', () => {
    expect(browserOwnedPage).not.toContain('executionOwner');
  });
});
