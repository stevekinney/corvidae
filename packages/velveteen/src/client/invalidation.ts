import type { Invalidation } from "../data/contract.ts";
import type { NavigationOptions } from "./types.ts";

export function createInvalidationHandlers(options: {
  currentUrl: () => URL;
  addressUrl: () => URL;
  request: (url: URL, settings?: NavigationOptions) => Promise<void>;
}) {
  const invalidate = async (
    value: string | string[] | ((url: URL) => boolean),
  ) => {
    const invalidation: Invalidation =
      typeof value === "function"
        ? value
        : (Array.isArray(value) ? value : [value]).map(
            (item) => new URL(item, options.addressUrl()).href,
          );
    await options.request(options.currentUrl(), {
      refresh: true,
      replace: true,
      invalidation,
    });
  };
  return {
    invalidate,
    invalidateAll: () =>
      options.request(options.currentUrl(), {
        refresh: true,
        replace: true,
        invalidation: "all",
      }),
  };
}
