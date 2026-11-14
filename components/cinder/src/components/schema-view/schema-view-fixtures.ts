/**
 * Browser fixtures for SchemaView.
 *
 * `anatomy` shows every type, required and optional fields, nested objects, defaults, formats
 * and constraints, descriptions of one, three and many lines, and a long unbroken field name, so
 * the layout tests can measure the rows, which happy-dom cannot.
 */
export default [
  {
    name: 'anatomy',
    host: './schema-view-anatomy.fixture.svelte',
  },
];
