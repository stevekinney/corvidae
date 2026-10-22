/**
 * Visual-regression fixtures for Drawer.
 *
 * Drawer requires children and footer snippets, so each variant renders
 * through a host fixture. The default `assertion` fixture only shows the
 * closed page, so this one holds the non-modal side panel open.
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
];
