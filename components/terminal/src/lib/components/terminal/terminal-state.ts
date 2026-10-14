import type { TerminalState } from './terminal.types.ts';

/**
 * Which behaviors each interaction state allows the renderer. The states and their copy come from
 * `documentation/terminal/experience.md`; the session controller decides which state applies.
 */

/**
 * States with no engine: nothing to show yet, the engine itself is unavailable, or access was
 * refused. A denied session never exposes a shell or accepts bytes, so it gets no input surface,
 * no engine load, and no subscription to the controller's output.
 */
const WITHOUT_ENGINE: ReadonlySet<TerminalState> = new Set([
  'empty',
  'denied',
  'engine-load-failed',
]);

/**
 * States in which this view fits itself to its viewport and reports the grid it measured. The
 * process is created, or is about to be, from that grid: after the first fit and before any
 * process exists (`loading`, `connecting`), and while the view is the writer.
 */
const OWNS_GRID: ReadonlySet<TerminalState> = new Set([
  'loading',
  'connecting',
  'writable',
  'backpressured',
]);

/** States that retain an error the reader must be able to see without the engine to read it. */
const ERROR: ReadonlySet<TerminalState> = new Set([
  'denied',
  'failed',
  'cleanup-incomplete',
  'engine-load-failed',
]);

/** Whether the state shows the engine, so retained output stays readable across transitions. */
export function mountsEngine(state: TerminalState): boolean {
  return !WITHOUT_ENGINE.has(state);
}

/** Whether the view measures its own viewport and reports the grid, rather than adopting one. */
export function ownsGrid(state: TerminalState): boolean {
  return OWNS_GRID.has(state);
}

/** Only a writable view accepts input and answers terminal queries. */
export function acceptsInput(state: TerminalState): boolean {
  return state === 'writable';
}

/** Whether the state is one of the four error states. */
export function isErrorState(state: TerminalState): boolean {
  return ERROR.has(state);
}
