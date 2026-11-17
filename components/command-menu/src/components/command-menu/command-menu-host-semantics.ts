/**
 * Writes `attributes` onto `host` and returns a function that puts every attribute it
 * changed back. A `null` value removes the attribute. An attribute is restored only while
 * it still holds the value this call wrote, so a value the host's own markup sets in the
 * meantime (the framework re-rendering `aria-expanded`, say) is never overwritten with a
 * stale snapshot.
 *
 * @internal Used by `CommandMenu` to give its host the combobox semantics the open menu implies.
 */
export function applyHostAttributes(
  host: HTMLElement,
  attributes: Readonly<Record<string, string | null>>,
): () => void {
  const changes: Array<{ name: string; prior: string | null; written: string | null }> = [];
  for (const [name, written] of Object.entries(attributes)) {
    const prior = host.getAttribute(name);
    if (prior === written) continue;
    if (written === null) host.removeAttribute(name);
    else host.setAttribute(name, written);
    changes.push({ name, prior, written });
  }
  return () => {
    for (const { name, prior, written } of changes) {
      if (host.getAttribute(name) !== written) continue;
      if (prior === null) host.removeAttribute(name);
      else host.setAttribute(name, prior);
    }
  };
}
