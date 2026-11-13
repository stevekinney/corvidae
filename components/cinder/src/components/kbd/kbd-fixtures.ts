/**
 * Visual-regression fixtures for Kbd.
 *
 * `button-shortcut` renders the key chip a Button's `shortcut` draws, on primary, secondary,
 * ghost and danger at small to large, and disabled, each beside the same button without a
 * shortcut, so the browser tests can check the chip and the button's height. It lives with Kbd,
 * whose rule draws the chip, and keeps Button within its fixture budget.
 */
export default [
  {
    name: 'button-shortcut',
    host: './kbd-button-shortcut.fixture.svelte',
  },
];
