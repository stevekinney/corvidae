/**
 * Visual-regression fixtures for DecisionDeck (COR-2441), at the budget of five.
 *
 * The default `assertion` fixture is the application's own, the deck at rest. Each fixture here
 * brings the deck into one state by driving it as a person would (`decision-deck-scenario.fixture
 * .svelte`): `drag-accept` and `drag-reject` hold a card mid-drag so its stamp shows, `drag-rtl`
 * does the same right to left (a drag toward the left accepts), `last-card` decides the only card
 * with reduced motion on so the screenshot is the resting frame (the Undo bar beside "All caught
 * up"), and `focused-long-title` wraps a long title and description (its capture cannot show the keyboard
 * ring, because the harness blurs the page first; `decision-deck-layout.playwright.ts` asserts the
 * ring on a real keyboard focus instead). An exit frozen mid-animation is not captured: the fixture harness forces
 * transitions and animations to zero, so it cannot hold the frame deterministically.
 */
export default [
  { name: 'drag-accept', host: './decision-deck-drag-accept.fixture.svelte' },
  { name: 'drag-reject', host: './decision-deck-drag-reject.fixture.svelte' },
  { name: 'drag-rtl', host: './decision-deck-drag-rtl.fixture.svelte' },
  { name: 'last-card', host: './decision-deck-last-card.fixture.svelte' },
  { name: 'focused-long-title', host: './decision-deck-focused-long-title.fixture.svelte' },
];
