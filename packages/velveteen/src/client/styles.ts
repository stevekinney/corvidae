/** A route is committed only after its stylesheets can be applied. Existing document links are reused. */
export async function ensureStylesheets(urls: string[], signal: AbortSignal) {
  await Promise.all(
    urls.map(async (href) => {
      const url = new URL(href, location.href).href;
      const existing = [
        ...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
      ].find((link) => link.href === url);
      if (existing?.sheet) return;
      const link = existing ?? document.createElement("link");
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          link.removeEventListener("load", load);
          link.removeEventListener("error", error);
          signal.removeEventListener("abort", abort);
        };
        const load = () => {
          cleanup();
          resolve();
        };
        const error = () => {
          cleanup();
          link.remove();
          reject(new Error(`Stylesheet failed: ${href}`));
        };
        const abort = () => {
          cleanup();
          if (!existing) link.remove();
          reject(signal.reason);
        };
        link.addEventListener("load", load, { once: true });
        link.addEventListener("error", error, { once: true });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        if (!existing) {
          link.rel = "stylesheet";
          link.href = url;
          document.head.append(link);
        }
      });
    }),
  );
}
