/**
 * happy-dom does no layout, so a test says whether a value is cut by stubbing the box sizes the
 * measurement reads (`scrollWidth` against `clientWidth`, `scrollHeight` against `clientHeight`).
 * Call it before rendering; it returns the function that puts the engine's own sizes back.
 *
 * @param cut Whether every element reads as cut (its content wider and taller than its box).
 */
export function stubCutLayout(cut: boolean): () => void {
  const prototype = HTMLElement.prototype as unknown as Record<string, unknown>;
  const sizes = {
    clientWidth: 100,
    scrollWidth: cut ? 300 : 100,
    clientHeight: 40,
    scrollHeight: cut ? 120 : 40,
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(sizes)) {
    originals.set(name, Object.getOwnPropertyDescriptor(prototype, name));
    Object.defineProperty(prototype, name, { configurable: true, get: () => value });
  }
  return () => {
    for (const [name, original] of originals) {
      if (original === undefined) delete prototype[name];
      else Object.defineProperty(prototype, name, original);
    }
  };
}
