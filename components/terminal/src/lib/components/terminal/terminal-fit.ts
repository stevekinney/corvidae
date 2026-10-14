import {
  MAXIMUM_TERMINAL_DIMENSION,
  MINIMUM_TERMINAL_DIMENSION,
} from '@lostgradient/ventriloquist';

import type { TerminalGeometry } from './terminal.types.ts';

function isValidDimension(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MINIMUM_TERMINAL_DIMENSION &&
    value <= MAXIMUM_TERMINAL_DIMENSION
  );
}

/**
 * The geometry when both dimensions are positive whole numbers the wire schema can carry, and
 * `undefined` otherwise. A hidden, detached, or zero-size container measures as zero or `NaN`;
 * nothing downstream ever sees an invented dimension in its place.
 */
export function validateGeometry(
  candidate: { columns?: unknown; rows?: unknown } | undefined,
): TerminalGeometry | undefined {
  if (candidate === undefined) return undefined;
  const { columns, rows } = candidate;
  return isValidDimension(columns) && isValidDimension(rows) ? { columns, rows } : undefined;
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
