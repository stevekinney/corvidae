/**
 * Visual-regression fixtures for Card.
 *
 * The default `assertion` fixture renders a card. `footer` renders a danger card and a default
 * card with a footer action, and a card with a muted footer, so the browser tests can measure the
 * gap between the words and the action and check that no divider is drawn. `suggested` renders a
 * suggested card with a title and one without, each beside its unsuggested sibling (COR-2326).
 */
export default [
  {
    name: 'footer',
    host: './card-footer.fixture.svelte',
  },
  {
    name: 'suggested',
    host: './card-suggested.fixture.svelte',
  },
];
