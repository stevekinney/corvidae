const key = "__velveteen";
type Position = { x: number; y: number };
export type HistoryEntry = {
  index: number;
  view: string;
  entryKey: string;
  lineage: string;
  renderedUrl?: string;
  state?: Record<string, unknown>;
};

function newHistoryKey() {
  return crypto.getRandomValues(new Uint32Array(4)).join("-");
}

/** Own framework metadata while preserving application history keys. */
export function createHistory() {
  const previous = history.scrollRestoration;
  history.scrollRestoration = "manual";
  const read = (value: unknown): HistoryEntry | undefined => {
    if (!value || typeof value !== "object" || !(key in value)) return;
    const entry = value[key];
    if (
      entry &&
      typeof entry === "object" &&
      "index" in entry &&
      Number.isSafeInteger(entry.index) &&
      "view" in entry &&
      typeof entry.view === "string" &&
      "entryKey" in entry &&
      typeof entry.entryKey === "string" &&
      "lineage" in entry &&
      typeof entry.lineage === "string"
    )
      return entry as HistoryEntry;
  };
  const existing = read(history.state);
  let current: HistoryEntry = existing ?? {
    index: 0,
    view: newHistoryKey(),
    entryKey: newHistoryKey(),
    lineage: newHistoryKey(),
  };
  // A reload renders the visible URL. Keep the saved entry so traversal
  // can still reactivate its shallow view.
  let renderedView = existing ? newHistoryKey() : current.view;
  if (!existing) history.replaceState({ ...history.state, [key]: current }, "");
  const positions = new Map<number, Position>();
  const save = () => positions.set(current.index, { x: scrollX, y: scrollY });
  addEventListener("scroll", save, { passive: true });
  let reverting = false;
  return {
    save,
    current: () => current,
    isRenderedView: (entry?: HistoryEntry) => entry?.view === renderedView,
    pop(value: unknown) {
      const target = read(value);
      if (reverting && target?.index === current.index) {
        reverting = false;
        return null;
      }
      reverting = false;
      return (
        target ?? {
          index: current.index,
          view: newHistoryKey(),
          entryKey: newHistoryKey(),
          lineage: newHistoryKey(),
        }
      );
    },
    revert(target: HistoryEntry) {
      if (target.index !== current.index) {
        reverting = true;
        history.go(current.index - target.index);
      }
    },
    commit(
      url: URL,
      options: {
        replace?: boolean;
        pop?: HistoryEntry;
        refresh?: boolean;
        renderedUrl?: string;
        state?: Record<string, unknown>;
      },
    ) {
      if (options.refresh) return;
      if (options.pop) {
        current = options.pop;
        renderedView = current.view;
        return;
      }
      const entry: HistoryEntry = {
        index: current.index + (options.replace ? 0 : 1),
        view: options.renderedUrl ? renderedView : newHistoryKey(),
        entryKey: options.replace ? current.entryKey : newHistoryKey(),
        lineage: current.lineage,
        renderedUrl: options.renderedUrl,
        state: options.state,
      };
      history[options.replace ? "replaceState" : "pushState"](
        { ...history.state, [key]: entry },
        "",
        url,
      );
      current = entry;
      renderedView = entry.view;
      if (!options.replace) {
        for (const index of positions.keys())
          if (index >= entry.index) positions.delete(index);
      }
    },
    restore(
      url: URL,
      options: {
        pop?: HistoryEntry;
        noScroll?: boolean;
        keepFocus?: boolean;
        refresh?: boolean;
      },
    ) {
      if (options.refresh) return;
      if (!options.noScroll) {
        const saved =
          options.pop !== undefined
            ? positions.get(options.pop.index)
            : undefined;
        if (saved) scrollTo(saved.x, saved.y);
        else if (url.hash) {
          let id = url.hash.slice(1);
          try {
            id = decodeURIComponent(id);
          } catch {
            /* Literal fragment remains usable. */
          }
          const target = document.getElementById(id);
          if (target) target.scrollIntoView();
          else scrollTo(0, 0);
        } else scrollTo(0, 0);
      }
      if (!options.keepFocus) {
        const old = document.body.getAttribute("tabindex");
        document.body.tabIndex = -1;
        document.body.focus({ preventScroll: true });
        if (old === null) document.body.removeAttribute("tabindex");
        else document.body.setAttribute("tabindex", old);
      }
    },
    dispose() {
      removeEventListener("scroll", save);
      history.scrollRestoration = previous;
      positions.clear();
    },
  };
}
