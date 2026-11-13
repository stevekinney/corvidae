/**
 * Browser fixtures for PhoneInput.
 *
 * `sizing` sets the field in every state, with long dial codes, in a narrow container and right
 * to left, so the layout tests can measure the country control's width, which happy-dom cannot.
 */
export default [
  {
    name: 'sizing',
    host: './phone-input-sizing.fixture.svelte',
  },
];
