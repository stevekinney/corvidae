import { matchRoute } from "../routing/match.ts";
import type { RuntimeRegistry } from "../data/contract.ts";
export function listenNavigation(input: {
  registry: RuntimeRegistry;
  base: string;
  inside: (url: URL) => boolean;
  link: (url: URL) => Promise<void>;
  pop: (state: unknown) => Promise<void>;
  preloadData: (url: string) => Promise<unknown>;
  preloadCode: (id: string) => Promise<void>;
  report: (error: unknown) => void;
}) {
  const { registry, base, inside, preloadData, preloadCode, report } = input;
  const onClick = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const element =
      event.target instanceof Element
        ? event.target
        : event.target instanceof Node
          ? event.target.parentElement
          : null;
    const anchor = element?.closest<HTMLAnchorElement>("a[href]");
    if (
      !anchor ||
      anchor.target ||
      anchor.hasAttribute("download") ||
      anchor.hasAttribute("data-velveteen-reload")
    )
      return;
    const url = new URL(anchor.href);
    if (!inside(url)) return;
    event.preventDefault();
    void input.link(url).catch(report);
  };
  const onPop = (event: PopStateEvent) => {
    void input.pop(event.state).catch(report);
  };
  const onPreload = (event: Event) => {
    const anchor =
      event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>("a[href]")
        : null;
    if (!anchor) return;
    if (anchor.hasAttribute("data-velveteen-preload-data"))
      void preloadData(anchor.href);
    else if (anchor.hasAttribute("data-velveteen-preload-code"))
      void (async () => {
        const url = new URL(anchor.href);
        if (!inside(url)) return;
        const matched = matchRoute(
          registry.manifest,
          url.pathname.slice(base.length) || "/",
          registry.matchers,
        );
        if (matched) await preloadCode(matched.route.id);
      })().catch(report);
  };
  document.addEventListener("click", onClick);
  addEventListener("popstate", onPop);
  document.addEventListener("pointerover", onPreload);
  document.addEventListener("touchstart", onPreload, { passive: true });
  return () => {
    document.removeEventListener("click", onClick);
    removeEventListener("popstate", onPop);
    document.removeEventListener("pointerover", onPreload);
    document.removeEventListener("touchstart", onPreload);
  };
}
