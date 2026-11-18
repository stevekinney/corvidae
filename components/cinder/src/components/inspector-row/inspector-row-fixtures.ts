/**
 * Visual-regression fixtures for InspectorRow.
 *
 * `suggested` renders a suggested row beside an unsuggested sibling, so the word "Suggested" above
 * the label can be judged (COR-2326, COR-2441).
 */
export default [
  {
    name: 'suggested',
    host: './inspector-row-suggested.fixture.svelte',
  },
];
