/**
 * Visual-regression fixtures for Inspector.
 */
export default [
  {
    // A detail page: the record's content, and its properties as a 20rem right rail beside it at
    // desktop width and as a section under the content on a phone. The rail is narrower than 700px,
    // so its rows stack their labels on the raised group at every width (COR-2394).
    name: 'detail-page',
    host: './inspector.fixture.svelte',
  },
  {
    // The same page with the properties as a full-width section under the content: an Inspector
    // 700px or wider sets each label beside its value on the tinted group.
    name: 'wide',
    host: './inspector.fixture.svelte',
    props: { layout: 'wide' },
  },
];
