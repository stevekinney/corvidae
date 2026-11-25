/**
 * The identity each step of the builder keeps while the steps around it move. The file's text is the
 * only state, so a step has no identity of its own: a step is at a path, and the path changes when a
 * neighbour is removed or moved. A list that must tell its rows apart across a move (Cinder's
 * `SortableList` keeps focus on the pressed button by the row's key), and a form that takes its
 * value once (a step's input, drawn by `SchemaForm`), both need a key that travels with the step and
 * is never built from its index (a move would hand the next keystroke to the wrong step) or from its
 * content (an edit would remount the form and lose the focus).
 *
 * `StepKeys` holds one key per step of every list it has been asked about, and follows the edits the
 * builder makes: a step moved takes its key, and the keys of everything nested in it, with it; one
 * removed takes them away. An edit the builder did not make (the JSON tab, a file that changed on
 * disk) cannot be followed, so the builder `reset`s, and every step gets a new key: its form is made
 * again from the new text, which is what shows the new text.
 */
import type { ListPath } from './workflow-builder-model.ts';

type Path = readonly (string | number)[];

interface KeyedList {
  readonly path: Path;
  readonly keys: string[];
  readonly order: string[];
}

interface RestorePosition {
  readonly list: ListPath;
  readonly index: number;
  readonly key: string;
  readonly descendants: readonly KeyedList[];
}

/** Whether `path` is `prefix` or lies below it. */
function startsWith(path: Path, prefix: Path): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

export class StepKeys {
  /** Counts each change, so a template that read the keys reads them again. */
  version = $state(0);

  #lists = new Map<string, KeyedList>();
  #issued = 0;

  /** The keys of the `length` steps of the list at `list`, new ones for steps it has not seen. */
  keysOf(list: ListPath, length: number): string[] {
    const id = JSON.stringify(list);
    let held = this.#lists.get(id);
    if (held === undefined) {
      held = { path: list, keys: [], order: [] };
      this.#lists.set(id, held);
    }
    while (held.keys.length < length) {
      const key = `step-${String(++this.#issued)}`;
      held.keys.push(key);
      held.order.push(key);
    }
    for (const key of held.keys.splice(length)) {
      held.order.splice(held.order.indexOf(key), 1);
    }
    return [...held.keys];
  }

  /** Forgets every key: the text changed in a way the builder did not make. */
  reset(): void {
    this.#lists.clear();
    this.version += 1;
  }

  /** The step at `index` of `list` moved by `offset` places, and took what is nested in it along. */
  moved(list: ListPath, index: number, offset: -1 | 1): void {
    const from = [...list, index];
    const to = [...list, index + offset];
    const next = new Map<string, KeyedList>();
    for (const held of this.#lists.values()) {
      let path = held.path;
      if (startsWith(held.path, from)) path = [...to, ...held.path.slice(from.length)];
      else if (startsWith(held.path, to)) path = [...from, ...held.path.slice(to.length)];
      next.set(JSON.stringify(path), { ...held, path });
    }
    const own = next.get(JSON.stringify(list));
    const first = own?.keys[index];
    const second = own?.keys[index + offset];
    if (own !== undefined && first !== undefined && second !== undefined) {
      own.keys[index] = second;
      own.keys[index + offset] = first;
      const firstPosition = own.order.indexOf(first);
      const secondPosition = own.order.indexOf(second);
      own.order[firstPosition] = second;
      own.order[secondPosition] = first;
    }
    this.#lists = next;
    this.version += 1;
  }

  /** The step at `index` of `list` removed, with what was nested in it, and the steps after it moved up. */
  removed(list: ListPath, index: number): void {
    const gone = [...list, index];
    const next = new Map<string, KeyedList>();
    for (const held of this.#lists.values()) {
      if (startsWith(held.path, gone)) continue;
      let path = held.path;
      const place = held.path[list.length];
      if (startsWith(held.path, list) && typeof place === 'number' && place > index) {
        path = [...list, place - 1, ...held.path.slice(list.length + 1)];
      }
      next.set(JSON.stringify(path), { ...held, path });
    }
    next.get(JSON.stringify(list))?.keys.splice(index, 1);
    this.#lists = next;
    this.version += 1;
  }

  /** Finds the deleted step's place in the same list after subsequent edits and parent moves. */
  undoPosition(list: ListPath, index: number): (() => RestorePosition | undefined) | undefined {
    const original = this.#lists.get(JSON.stringify(list));
    const key = original?.keys[index];
    if (original === undefined || key === undefined) return undefined;
    const removedPath = [...list, index];
    const descendants = [...this.#lists.values()]
      .filter((held) => startsWith(held.path, removedPath))
      .map((held) => ({ ...held, path: held.path.slice(removedPath.length) }));

    return () => {
      const held = [...this.#lists.values()].find((entry) => entry.keys === original.keys);
      if (held === undefined || held.keys.includes(key)) return undefined;
      const orderIndex = held.order.indexOf(key);
      // Deleted keys retain their place in order so adjacent steps can be restored in either order.
      const active = new Set(held.keys);
      const restoreIndex = held.order
        .slice(0, orderIndex)
        .filter((entry) => active.has(entry)).length;
      return { list: held.path, index: restoreIndex, key, descendants };
    };
  }

  /** Restores the key and its nested list identities while shifting surviving steps down. */
  inserted({ list, index, key, descendants }: RestorePosition): void {
    const next = new Map<string, KeyedList>();
    for (const held of this.#lists.values()) {
      let path = held.path;
      const place = path[list.length];
      if (startsWith(path, list) && typeof place === 'number' && place >= index) {
        path = [...list, place + 1, ...path.slice(list.length + 1)];
      }
      next.set(JSON.stringify(path), { ...held, path });
    }
    next.get(JSON.stringify(list))?.keys.splice(index, 0, key);
    for (const held of descendants) {
      const path = [...list, index, ...held.path];
      next.set(JSON.stringify(path), { ...held, path });
    }
    this.#lists = next;
    this.version += 1;
  }

  /** The case or list at `slot` (`[...step, 'cases', name]`) named `name` instead, with what is in it. */
  slotRenamed(slot: Path, name: string): void {
    const next = new Map<string, KeyedList>();
    for (const held of this.#lists.values()) {
      let path = held.path;
      if (startsWith(held.path, slot)) {
        path = [...slot.slice(0, -1), name, ...held.path.slice(slot.length)];
      }
      next.set(JSON.stringify(path), { ...held, path });
    }
    this.#lists = next;
    this.version += 1;
  }

  /** The case or list at `slot` removed, with what was in it. */
  slotRemoved(slot: Path): void {
    for (const [id, held] of this.#lists) {
      if (startsWith(held.path, slot)) this.#lists.delete(id);
    }
    this.version += 1;
  }
}
