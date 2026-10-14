/**
 * The terminal engine the terminal contract selected. It is private behind the controller: nothing
 * outside this package receives an engine instance, and there is no engine selector or fallback.
 * The root catalog pins the same version, and the package tests fail when the two drift.
 */
export const TERMINAL_ENGINE = {
  packageName: '@xterm/xterm',
  version: '6.0.0',
} as const;
