/**
 * The element the design system's bundle renders a component's `children` into, and the Svelte
 * context each one carries, so that a component mounted inside another one's children (a
 * `TabList` inside `Tabs`, say) joins its parent's context as it would in a Svelte template.
 */

/**
 * Fills the element a component renders for its `children`, and returns what undoes it. The
 * element is a `display: contents` span, so its content lays out as the component's own.
 */
export type FillChildren = (host: HTMLElement) => (() => void) | void;

const contextsByHost = new WeakMap<Element, Map<unknown, unknown>>();

/** Records the Svelte context a children host was rendered in. */
export function rememberContexts(host: Element, contexts: Map<unknown, unknown>): void {
  contextsByHost.set(host, contexts);
}

/** Forgets a children host's context when the host is removed. */
export function forgetContexts(host: Element): void {
  contextsByHost.delete(host);
}

/**
 * The context of the nearest children host that contains `target`, or nothing when `target` is
 * not inside another bundled component.
 */
export function contextsFor(target: Element): Map<unknown, unknown> | undefined {
  for (let node: Element | null = target; node !== null; node = node.parentElement) {
    const contexts = contextsByHost.get(node);
    if (contexts !== undefined) return contexts;
  }
  return undefined;
}
