/**
 * What the context-window ring says about a `bureau.contexts.window` report: how much of the window
 * the next prompt fills, and how worried to look about it. The numbers are the Bureau's; this only
 * turns them into a fraction and a tone, so the ring and its breakdown agree.
 */
import type { ContextWindow } from '../../lib/bureau-client.ts';

/** How full the window is, for the color of the ring. */
export type WindowTone = 'normal' | 'warning' | 'danger' | 'unknown';

/** From this share of the window, the ring warns. */
export const WINDOW_WARNING_FRACTION = 0.7;
/** From this share of the window, the ring says the window is nearly full. */
export const WINDOW_DANGER_FRACTION = 0.9;

/** The share of the window the report fills. */
export interface WindowUse {
  /** The tokens the next prompt would send, estimated. */
  readonly used: number;
  /** The window, `null` when the model is not known. */
  readonly max: number | null;
  /** The share filled, in whole percent and uncapped; `null` when the window is not known. */
  readonly percent: number | null;
  /** The share to draw, from 0 to 1; `0` when the window is not known. */
  readonly drawn: number;
  readonly tone: WindowTone;
}

/** What `report` fills of its window. The estimate is used because it is what the breakdown sums to. */
export function windowUse(report: ContextWindow): WindowUse {
  const used = report.usedEstimated;
  const max = report.maxTokens;
  if (max === null || max === 0) {
    return { used, max: null, percent: null, drawn: 0, tone: 'unknown' };
  }
  const fraction = used / max;
  return {
    used,
    max,
    percent: Math.round(fraction * 100),
    drawn: Math.min(1, fraction),
    tone:
      fraction >= WINDOW_DANGER_FRACTION
        ? 'danger'
        : fraction >= WINDOW_WARNING_FRACTION
          ? 'warning'
          : 'normal',
  };
}

const NUMBER = new Intl.NumberFormat('en-US');

/** A token count with thousands separators. */
export function formatTokens(tokens: number): string {
  return NUMBER.format(tokens);
}
