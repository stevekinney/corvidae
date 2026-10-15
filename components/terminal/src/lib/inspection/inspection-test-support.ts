import type { ClearScope } from '../components/terminal/terminal-engine-adapter.ts';
import type { TerminalProjection } from '../components/terminal/terminal-projection.ts';
import { createInspection, type Inspection } from './inspection-controller.ts';
import type { InspectionEvent, InspectionSource } from './inspection-types.ts';

const encoder = new TextEncoder();

/** A source whose text, truncation and generation the test sets, and whose clears it records. */
export type FakeSource = InspectionSource & {
  text: string;
  truncated: boolean;
  /** Return `undefined` from `readProjection`, as an engine that went away does. */
  gone: boolean;
  reads: number[];
  clears: ClearScope[];
  selections: Array<{ start: number; end: number; text: string }>;
  selectionClears: number;
  /** What `selectMatch` answers. */
  selectable: boolean;
  /** Hold `done` callbacks until the test releases them, as a busy write queue does. */
  deferClears: boolean;
  pendingDone: Array<() => void>;
};

export function createFakeSource(text = '', generation = 1): FakeSource {
  const source: FakeSource = {
    generation,
    text,
    truncated: false,
    gone: false,
    reads: [],
    clears: [],
    selections: [],
    selectionClears: 0,
    selectable: true,
    deferClears: false,
    pendingDone: [],
    readProjection(maximumBytes): TerminalProjection | undefined {
      source.reads.push(maximumBytes);
      if (source.gone) return undefined;
      return {
        text: source.text,
        truncated: source.truncated,
        bytes: encoder.encode(source.text).length,
        lines: [],
      };
    },
    selectMatch(match) {
      source.selections.push(match);
      return source.selectable;
    },
    clearMatchSelection() {
      source.selectionClears += 1;
    },
    clear(scope, done) {
      source.clears.push(scope);
      if (source.deferClears) source.pendingDone.push(done);
      else done();
      return true;
    },
  };
  return source;
}

/** A timer whose callbacks run only when the test says so, remembering the delay each asked for. */
export function createManualTimer() {
  const pending: Array<{ callback: () => void; delay: number }> = [];
  return {
    start(callback: () => void, delay: number) {
      const entry = { callback, delay };
      pending.push(entry);
      return () => {
        const index = pending.indexOf(entry);
        if (index >= 0) pending.splice(index, 1);
      };
    },
    /** Run what is waiting, as the clock reaching every delay would. */
    flush() {
      for (const entry of pending.splice(0)) entry.callback();
    },
    get pending() {
      return pending.length;
    },
    get delays() {
      return pending.map((entry) => entry.delay);
    },
  };
}

export type InspectionHarness = {
  inspection: Inspection;
  source: { current: InspectionSource | undefined };
  events: InspectionEvent[];
  announcements: string[];
  timer: ReturnType<typeof createManualTimer>;
  link: { current: ((url: string) => void) | undefined };
  hook: { current: ((event: InspectionEvent) => void) | undefined };
};

/** An inspection controller wired to a fake source, with every outward call recorded. */
export function createHarness(initial?: InspectionSource): InspectionHarness {
  const source = { current: initial };
  const events: InspectionEvent[] = [];
  const announcements: string[] = [];
  const timer = createManualTimer();
  const link: InspectionHarness['link'] = { current: undefined };
  const hook: InspectionHarness['hook'] = { current: (event) => events.push(event) };
  const inspection = createInspection({
    readSource: () => source.current,
    readActivateLink: () => link.current,
    readOnEvent: () => hook.current,
    announce: (message) => announcements.push(message),
    timer: (callback, delay) => timer.start(callback, delay),
  });
  return { inspection, source, events, announcements, timer, link, hook };
}
