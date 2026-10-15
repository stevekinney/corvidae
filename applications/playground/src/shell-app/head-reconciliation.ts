/**
 * Reconciles the `<head>` between two prerendered documents.
 *
 * Only the resources that change what a page looks like are managed: stylesheet links and
 * `<style>` blocks. The diff is by identity (a stylesheet's resolved URL, a style's text), so a
 * resource both documents share, such as the shared documentation stylesheet, stays in place and
 * is never reloaded. Callers add what is missing first and remove what is stale only after the
 * new page is in place, so there is no frame without styles.
 */

/** The parts of a head element the identity reads. */
export type HeadElementLike = {
  tagName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
};

/** The stable identity of a managed head resource, or `null` for an element left alone. */
export function headResourceKey(element: HeadElementLike, baseUrl: string): string | null {
  const tag = element.tagName.toLowerCase();
  if (tag === 'link') {
    const rel = (element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    const href = element.getAttribute('href');
    if (!rel.includes('stylesheet') || href === null || href === '') return null;
    try {
      return `link:${new URL(href, baseUrl).href}`;
    } catch {
      return null;
    }
  }
  if (tag === 'style') {
    const text = element.textContent ?? '';
    return text.trim() === '' ? null : `style:${text}`;
  }
  return null;
}

export type HeadReconciliationPlan = {
  /** Keys present in the target and missing from the current head, in target order. */
  add: string[];
  /** Keys in the current head the target does not have, in current order. */
  remove: string[];
};

export function planHeadReconciliation(
  currentKeys: readonly string[],
  targetKeys: readonly string[],
): HeadReconciliationPlan {
  const current = new Set(currentKeys);
  const target = new Set(targetKeys);
  return {
    add: [...target].filter((key) => !current.has(key)),
    remove: [...current].filter((key) => !target.has(key)),
  };
}
