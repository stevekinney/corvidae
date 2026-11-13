/**
 * Browser-only Chat regressions. This host is deliberately absent from
 * `chat.examples.json`: published examples remain concise, while the
 * implementation exercises its full interaction matrix in private CI.
 */

/** Chat holds six fixtures, one over the budget of five: the unconfigured states joined the five. */
export const visualFixtureMetadata = {
  fixtureBudgetOverride: {
    reason:
      'The no-provider fixture (COR-2285 V4) draws two states no other fixture holds: the Connect a model provider state in place of an empty conversation, and the blocked composer row beside one with history.',
    approvedBy: 'coordinator, relaying the COR-2285 V4 decision of 2026-11-13',
  },
};

export default [
  {
    name: 'private-harness',
    host: './chat-private-harness.fixture.svelte',
    category: 'interaction-state',
  },
  {
    name: 'private-history-prepend-stress',
    host: './chat-private-history-prepend-stress.fixture.svelte',
    category: 'interaction-state',
  },
  {
    name: 'private-lightbox-nested-overlay',
    host: './chat-private-lightbox-nested-overlay.fixture.svelte',
    category: 'interaction-state',
    // Without these, every committed baseline for this fixture only ever
    // captured the CLOSED initial state (the "Open drawer" trigger button,
    // nothing else) — the fixture exists specifically to exercise the
    // nested Drawer + ImageLightbox overlay stack, so a snapshot that never
    // opens either overlay never actually verifies anything about that
    // stack. Two steps, applied in order: open the Drawer first (its own
    // trigger button), then the image viewer nested inside it
    // (`data-testid="open-lightbox"`, since "Open image" is not unique
    // across the whole page once other fixtures render alongside it).
    interact: [
      { action: 'click', target: { role: 'button', name: 'Open drawer' } },
      { action: 'click', target: { testId: 'open-lightbox' } },
    ],
  },
  {
    // An empty composer, whose send button is disabled, above one holding a draft.
    name: 'composer-send',
    host: './chat-composer.fixture.svelte',
    props: { drafts: true },
    category: 'visual-contract',
  },
  {
    name: 'composer-stop',
    host: './chat-composer.fixture.svelte',
    props: { streaming: true },
    category: 'visual-contract',
  },
  {
    // No model provider (COR-2285 V4): with no message, the Connect a model provider state; beside
    // a conversation, the transcript stays and only the composer is the blocked Connect provider
    // row (ChatStates rows 19f and 19h). Both in one fixture, one above the other.
    name: 'unconfigured',
    host: './chat-unconfigured.fixture.svelte',
    category: 'visual-contract',
  },
];
