import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';

/** Keep a resource active while its element is mounted. */
export function activateResource(resource: { activate(): () => void }): Attachment<EventTarget> {
  return () => untrack(() => resource.activate());
}

/** Request the next page when the sentinel is visible. */
export function loadMoreWhenVisible(
  resource: { loadMore(): Promise<void> },
  options?: IntersectionObserverInit,
): Attachment<Element> {
  return (element) => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting))
        void resource.loadMore().catch(() => undefined);
    }, options);
    observer.observe(element);
    return () => observer.disconnect();
  };
}
