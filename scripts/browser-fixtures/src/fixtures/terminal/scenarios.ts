import type { TerminalState } from '@lostgradient/terminal';

import {
  BRACKETED_PASTE_ON,
  EXITED_TRANSCRIPT,
  FAILED_TRANSCRIPT,
  MOUSE_TRACKING_SGR,
  PASTE_SAMPLE,
  READ_ONLY_TRANSCRIPT,
  TRANSCRIPT,
  numberedLines,
} from './programs.ts';

/**
 * What a visual fixture does after the engine is mounted and its output is parsed: a step the
 * host runs through the page, the way a reader would, so the resting state needs no private hook.
 */
export type FixtureStep =
  'capture' | 'export' | 'export-stale' | 'export-truncated' | 'paste-review';

export type FixtureScenario = {
  state: TerminalState;
  /** Output the session has produced before the engine mounts. */
  output?: string;
  mouseReporting?: boolean;
  /** A recovery handler, so a state that offers recovery shows its control. */
  recovery?: boolean;
  /** The recovery action handlers (`onNewSession`, `onRetry`, ...), so the state shows its buttons. */
  actions?: boolean;
  cleanupPending?: boolean;
  step?: FixtureStep;
};

/**
 * The visual fixture IDs of `documentation/terminal/experience.md`, one per state or variant the
 * table names, since an ID is also a file name. `denied`, `failed` and `engine-load-failed` are
 * states the host passes in; the real failures live in the behavioral specs, because the shared
 * sweep fails any fixture whose page logs an error.
 */
export const VISUAL_SCENARIOS = {
  empty: { state: 'empty', actions: true },
  loading: { state: 'loading', actions: true },
  connecting: { state: 'connecting', actions: true },
  writable: { state: 'writable', output: TRANSCRIPT },
  'read-only': { state: 'read-only', output: READ_ONLY_TRANSCRIPT },
  backpressured: { state: 'backpressured', output: TRANSCRIPT },
  exited: { state: 'exited', output: EXITED_TRANSCRIPT, actions: true },
  disconnected: { state: 'disconnected', output: EXITED_TRANSCRIPT, actions: true },
  denied: { state: 'denied', actions: true },
  failed: { state: 'failed', output: FAILED_TRANSCRIPT, actions: true },
  'engine-load-failed': { state: 'engine-load-failed', recovery: true },
  'cleanup-incomplete': {
    state: 'cleanup-incomplete',
    output: FAILED_TRANSCRIPT,
    actions: true,
    cleanupPending: true,
  },
  'snapshot-modal': { state: 'writable', output: TRANSCRIPT, step: 'export' },
  'snapshot-modal-stale': { state: 'writable', output: TRANSCRIPT, step: 'export-stale' },
  'snapshot-modal-truncated': {
    state: 'writable',
    output: numberedLines(9000),
    step: 'export-truncated',
  },
  'keyboard-capture': { state: 'writable', output: TRANSCRIPT, step: 'capture' },
  'keyboard-paste-review': {
    state: 'writable',
    output: `${BRACKETED_PASTE_ON}${TRANSCRIPT}`,
    step: 'paste-review',
  },
  'keyboard-mouse-reporting': {
    state: 'writable',
    output: `${MOUSE_TRACKING_SGR}${TRANSCRIPT}`,
    mouseReporting: true,
    step: 'capture',
  },
} as const satisfies Record<string, FixtureScenario>;

export type VisualFixtureName = keyof typeof VISUAL_SCENARIOS;

/** The interactive fixture the behavioral specs drive. It also has a resting baseline. */
export const LAB_FIXTURE = 'lab';

export const TERMINAL_FIXTURE_NAMES: readonly string[] = [
  ...Object.keys(VISUAL_SCENARIOS),
  LAB_FIXTURE,
];

export { PASTE_SAMPLE };
