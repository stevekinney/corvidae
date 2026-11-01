/**
 * What the end-to-end host's saved tool sources are, for the specifications that read them
 * (`connect-tools.spec.ts`, `responsive.spec.ts`): the identifiers, and the values the seed gives
 * them (`tool-sources-seed.ts`). Kept apart from the seed so a specification never imports a server.
 */

/** The identifiers of the saved tool sources the main host starts with. */
export const E2E_TOOL_SOURCES = {
  /** An MCP server over HTTP that answers anyone: loaded, with a read-only tool and a dangerous one. */
  notes: 'e2e-notes',
  /** An OpenAPI service from an embedded document: loaded, with a tool the owner already flagged. */
  petstore: 'e2e-petstore',
  /** An MCP server behind OAuth that nobody has signed in to yet. */
  ledger: 'e2e-ledger',
  /** An MCP server nothing listens for, so the host reports why it failed. */
  broken: 'e2e-broken',
} as const;

/** A saved setting for a tool the petstore does not list: one 300-character word, which the page prints. */
export const E2E_UNMATCHED_TOOL = `unmatched-${'u'.repeat(300)}`;

/** A tool of the petstore with a long name, so the row is measured with it. */
export const E2E_LONG_OPERATION = 'listEverythingThePetstoreKnowsAbout';

/** A tool of the petstore the seed flags `acceptsSecrets`, so a reload is shown to read it. */
export const E2E_FLAGGED_TOOL = 'create-pet';
