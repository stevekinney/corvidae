import {
  MAXIMUM_TERMINAL_DIMENSION,
  MINIMUM_TERMINAL_DIMENSION,
} from '@lostgradient/ventriloquist';

import { SCROLLBACK_LINES } from './terminal-engine-adapter.ts';
import type { TerminalGeometry } from './terminal.types.ts';

/**
 * The most cells the engine may be asked to retain: columns × (rows + scrollback). The documents
 * state no cell budget, so this one is chosen here. The engine stores 12 bytes a cell (three
 * 32-bit words) for every visible and scrollback row, so 2^23 cells is about 100 MiB at worst.
 * It admits a 24-row grid up to about 830 columns, far past any real display, and refuses
 * 65,535 × 65,535, which would ask for hundreds of gigabytes. The scrollback is counted because
 * it multiplies the width: a very wide, very short grid is the expensive one.
 */
export const MAXIMUM_RETAINED_TERMINAL_CELLS = 2 ** 23;

function isValidDimension(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MINIMUM_TERMINAL_DIMENSION &&
    value <= MAXIMUM_TERMINAL_DIMENSION
  );
}

/**
 * The geometry when both dimensions are positive whole numbers the wire schema can carry and the
 * grid fits the retained-cell budget, and `undefined` otherwise. A hidden, detached, or zero-size container measures as zero or `NaN`;
 * nothing downstream ever sees an invented dimension in its place.
 */
export function validateGeometry(
  candidate: { columns?: unknown; rows?: unknown } | undefined,
): TerminalGeometry | undefined {
  if (candidate === undefined) return undefined;
  const { columns, rows } = candidate;
  if (!isValidDimension(columns) || !isValidDimension(rows)) return undefined;
  if (columns * (rows + SCROLLBACK_LINES) > MAXIMUM_RETAINED_TERMINAL_CELLS) return undefined;
  return { columns, rows };
}

export function sameGeometry(left: TerminalGeometry, right: TerminalGeometry): boolean {
  return left.columns === right.columns && left.rows === right.rows;
}

/** Schedules `callback` once and returns a function that cancels it before it runs. */
export type FitScheduler = (callback: () => void) => () => void;

/** Runs a fit on the next animation frame, or on the next task where frames do not exist. */
export const scheduleFitOnNextFrame: FitScheduler = (callback) => {
  if (typeof requestAnimationFrame === 'function') {
    const handle = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(handle);
  }
  const handle = setTimeout(callback, 0);
  return () => clearTimeout(handle);
};

export type FitCoordinatorOptions = {
  /** The engine's own measurement of the geometry that fits its container, or `undefined`. */
  measure: () => { columns?: unknown; rows?: unknown } | undefined;
  /** Resize the engine to an accepted geometry. */
  apply: (geometry: TerminalGeometry) => void;
  /** Report an accepted geometry to the host. Called once per distinct accepted geometry. */
  accept: (geometry: TerminalGeometry) => void;
  schedule?: FitScheduler;
};

export type FitCoordinator = {
  /** Ask for a fit. Any number of requests before the next frame collapse into one measurement. */
  request(): void;
  /** The last accepted geometry, if any. */
  readonly accepted: TerminalGeometry | undefined;
  /**
   * Forget the accepted geometry, so the next valid measurement is applied and reported even when
   * it equals the old one. Used when something else resized the engine in between.
   */
  invalidate(): void;
  /** Cancel pending work. Later requests do nothing. */
  dispose(): void;
};

/**
 * Turns every signal that can change the fit (container resize, font load, zoom, device-pixel
 * ratio) into at most one measurement per frame, and a measurement into at most one effective
 * resize per accepted geometry. A measurement that is invalid, or equal to the geometry already
 * accepted, changes nothing and is reported to no one.
 */
export function createFitCoordinator(options: FitCoordinatorOptions): FitCoordinator {
  const schedule = options.schedule ?? scheduleFitOnNextFrame;
  let accepted: TerminalGeometry | undefined;
  let cancelPending: (() => void) | undefined;
  let disposed = false;

  function fit(): void {
    cancelPending = undefined;
    const geometry = validateGeometry(options.measure());
    if (geometry === undefined) return;
    if (accepted !== undefined && sameGeometry(accepted, geometry)) return;
    accepted = geometry;
    options.apply(geometry);
    options.accept(geometry);
  }

  return {
    request() {
      if (disposed || cancelPending !== undefined) return;
      cancelPending = schedule(fit);
    },
    get accepted() {
      return accepted;
    },
    invalidate() {
      accepted = undefined;
    },
    dispose() {
      disposed = true;
      cancelPending?.();
      cancelPending = undefined;
    },
  };
}
