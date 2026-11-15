/**
 * Visual-regression fixtures for ListDetail's collapsible list (COR-2327 AC1): the toggle at the
 * end of the list header while the list shows, and the rail that holds it while the list is hidden.
 * `grouped-selection` pins the selected row's shape under a group heading.
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
  // The documented tools example: a grouped list in a framed box with the first row under a group
  // heading selected. Under 800px the detail sits below the list, so a phone shows the row too.
  {
    name: 'grouped-selection',
    host: './list-detail-groups.fixture.svelte',
    props: {
      selectedKey: 'discover-agents',
      selectionParameter: null,
      pushBelow: 0,
      stackBelow: 800,
    },
  },
];
