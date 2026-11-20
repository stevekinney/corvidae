import { parse, stringify } from "devalue";
import type { SnapshotRegistration } from "../data/contract.ts";
import {
  transportReducers,
  transportRevivers,
  type Transport,
} from "../data/custom-transport.ts";
import type { HistoryEntry } from "./history.ts";

type Frame = { entryKey: string; values: Map<string, string> };
type Frames = Map<number, Frame>;

export function createSnapshots(basePath: string, transport?: Transport) {
  const reducers = transportReducers(transport);
  const revivers = transportRevivers(transport);
  const registrations = new Set<SnapshotRegistration<unknown>>();
  const histories = new Map<string, Frames>();
  const storageKey = (lineage: string) =>
    `__velveteen:snapshots:${encodeURIComponent(basePath)}:${lineage}`;

  function framesFor(lineage: string): Frames {
    const existing = histories.get(lineage);
    if (existing) return existing;
    let frames: Frames = new Map();
    try {
      const stored = sessionStorage.getItem(storageKey(lineage));
      const parsed: unknown = stored ? parse(stored) : undefined;
      if (parsed instanceof Map) frames = parsed;
    } catch {
      // Live snapshots work in memory when browser storage is unavailable.
    }
    histories.set(lineage, frames);
    return frames;
  }

  function stage(entry: HistoryEntry) {
    const values = new Map<string, string>();
    for (const { id, capture } of registrations) {
      values.set(id, stringify(capture(), reducers));
    }
    return () => {
      const frames = framesFor(entry.lineage);
      if (values.size)
        frames.set(entry.index, { entryKey: entry.entryKey, values });
      else frames.delete(entry.index);
    };
  }

  return {
    register<Value>(this: void, registration: SnapshotRegistration<Value>) {
      const erased = registration as SnapshotRegistration<unknown>;
      registrations.add(erased);
      return () => {
        registrations.delete(erased);
      };
    },
    stage,
    discard(entry: HistoryEntry, replace: boolean) {
      const frames = framesFor(entry.lineage);
      for (const index of frames.keys()) {
        if (index === entry.index || (!replace && index > entry.index)) {
          frames.delete(index);
        }
      }
    },
    restore(entry: HistoryEntry) {
      if (!registrations.size) return;
      const frame = framesFor(entry.lineage).get(entry.index);
      if (frame?.entryKey !== entry.entryKey || !(frame.values instanceof Map))
        return;
      for (const { id, restore } of registrations) {
        const value = frame.values.get(id);
        if (typeof value === "string") restore(parse(value, revivers));
      }
    },
    attach(current: () => HistoryEntry, report: (error: unknown) => void) {
      const persist = () => {
        try {
          stage(current())();
        } catch (error) {
          report(error);
        }
        try {
          for (const [lineage, frames] of histories) {
            if (frames.size)
              sessionStorage.setItem(storageKey(lineage), stringify(frames));
            else sessionStorage.removeItem(storageKey(lineage));
          }
        } catch {
          // Storage can be disabled or at quota without disrupting navigation.
        }
      };
      addEventListener("pagehide", persist);
      return () => removeEventListener("pagehide", persist);
    },
    dispose() {
      registrations.clear();
      histories.clear();
    },
  };
}
