/**
 * Visual-regression fixtures for Drawer.
 *
 * Drawer requires children and footer snippets, so each variant renders
 * through a host fixture. The default `assertion` fixture only shows the
 * closed page, so this one holds the non-modal side panel open.
 *
 * The two sheet fixtures open a bottom sheet at its `medium` detent over a page that draws the
 * same GroupedList, so the browser tests can compare the rows the sheet keeps with the rows the
 * page draws, and can drag, key and tap the sheet through its detents.
 */
export default [
  {
    name: 'non-modal-open',
    host: './drawer.fixture.svelte',
    props: {
      open: true,
      modal: false,
    },
  },
  {
    name: 'sheet-detents',
    host: './drawer-sheet.fixture.svelte',
    props: {
      open: true,
      detents: ['peek', 'medium', 'large'],
      detent: 'medium',
      count: '12 results',
      rows: 12,
    },
  },
  {
    name: 'sheet-header-bar',
    host: './drawer-sheet.fixture.svelte',
    props: {
      open: true,
      detents: ['medium', 'large'],
      detent: 'medium',
      count: '12 results',
      rows: 12,
      headerBar: true,
    },
  },
];
