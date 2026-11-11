/**
 * Visual-regression fixtures for Modal.
 *
 * Modal requires children/footer snippets, so these variants render through a
 * host fixture and keep the non-snippet configuration as JSON props.
 */
export default [
  {
    name: 'open',
    host: './modal.fixture.svelte',
    props: {
      open: true,
      title: 'Open dialog',
    },
  },
  {
    name: 'open-with-description',
    host: './modal.fixture.svelte',
    props: {
      open: true,
      title: 'Open dialog with description',
      describedById: 'modal-description',
    },
  },
  {
    name: 'closed',
    host: './modal.fixture.svelte',
    props: {
      open: false,
      title: 'Closed dialog',
    },
  },
  {
    name: 'anchored-overlay',
    host: './modal.fixture.svelte',
    props: {
      anchoredOverlay: true,
      open: true,
      title: 'Dialog with anchored overlay',
    },
  },
  {
    // The bottom sheet below 760px: opened at the fixture's phone viewport, it docks with a 20px top
    // radius, a grabber, an upward shadow and 32px under the footer.
    name: 'sheet',
    host: './modal.fixture.svelte',
    props: {
      open: true,
      title: 'Filter runs',
      sheetBelow: '760px',
    },
  },
];
