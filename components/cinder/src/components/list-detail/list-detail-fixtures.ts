/**
 * Visual-regression fixtures for ListDetail's collapsible list (COR-2327 AC1): the toggle at the
 * end of the list header while the list shows, and the rail that holds it while the list is hidden.
 */
export default [
  {
    name: 'list-collapsible',
    host: './list-detail.fixture.svelte',
    props: {
      selectedKey: 'beta',
      selectionParameter: null,
      listCollapsible: true,
    },
  },
  {
    name: 'list-collapsed',
    host: './list-detail.fixture.svelte',
    props: {
      selectedKey: 'beta',
      selectionParameter: null,
      listCollapsible: true,
      listCollapsed: true,
    },
  },
];
