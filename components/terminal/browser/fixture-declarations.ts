import { TERMINAL_FIXTURE_NAMES } from './fixtures/terminal/scenarios.ts';

/**
 * The application fixtures in `fixtures/`, by component, that the terminal's browser suite serves.
 * The root suite (`scripts/browser-fixtures`) serves them too, but its component sweep leaves the
 * terminal to `tests/terminal-visual.playwright.ts`, which owns the terminal's baselines.
 */
export const terminalAppFixtureDeclarations = {
  terminal: TERMINAL_FIXTURE_NAMES,
} as const satisfies Record<string, readonly string[]>;
