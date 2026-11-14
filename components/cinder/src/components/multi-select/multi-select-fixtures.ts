/**
 * Browser fixtures for MultiSelect.
 *
 * `trailing` sets closed fields at every size and in every state beside a Select and a Combobox,
 * so the layout tests can measure where the clear x and the chevron sit, which happy-dom cannot.
 */
export default [
  {
    name: 'trailing',
    host: './multi-select-trailing.fixture.svelte',
  },
];
