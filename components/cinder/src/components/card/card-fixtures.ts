/**
 * Visual-regression fixtures for Card.
 *
 * The default `assertion` fixture renders a card. `footer` renders a danger card and a default
 * card with a footer action, and a card with a muted footer, so the browser tests can measure the
 * gap between the words and the action and check that no divider is drawn.
 */
export default [
  {
    name: 'footer',
    host: './card-footer.fixture.svelte',
  },
];
