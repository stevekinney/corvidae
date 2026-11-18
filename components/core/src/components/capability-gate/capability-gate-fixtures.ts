/**
 * Visual-regression fixtures for CapabilityGate.
 *
 * The default `assertion` fixture renders the microphone permission gate. `actions` renders the
 * gate on each of its tints with a primary and a secondary Button, beside a primary Button on the
 * page, so the browser tests can check the gate never restyles its actions.
 */
export default [
  {
    name: 'actions',
    host: './capability-gate-actions.fixture.svelte',
  },
];
