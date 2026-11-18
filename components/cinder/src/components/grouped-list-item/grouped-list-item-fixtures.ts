/**
 * Visual-regression fixtures for GroupedListItem.
 *
 * `suggested` renders a suggested row with a trailing value beside an unsuggested sibling, so the
 * word "Suggested" above the title and the trailing column can be judged (COR-2326, COR-2441).
 */
export default [
  {
    name: 'suggested',
    host: './grouped-list-item-suggested.fixture.svelte',
  },
];
