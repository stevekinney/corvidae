import type { Component } from "svelte";
import type { Data, ResolvedPage } from "../data/contract.ts";
import type { ServerRegistry } from "./types.ts";
import { LoadFailure } from "../data/errors.ts";
/** Attach a node identity to SSR component errors so the enclosing route boundary can be selected. */
export function renderPage(registry: ServerRegistry, page: ResolvedPage) {
  const branch = page.branch.map((node) => {
    const original = node.component;
    if (!original || node.node === null || node.role === "error") return node;
    const component: Component<Record<string, unknown>> = (...arguments_) => {
      try {
        return original(...arguments_);
      } catch (cause) {
        throw cause instanceof LoadFailure
          ? cause
          : new LoadFailure(
              node.node!,
              node.role as "layout" | "page",
              cause,
              page.loads,
            );
      }
    };
    return { ...node, component };
  });
  return registry.render(registry.Root, {
    props: { state: { page: { ...page, branch }, state: {} } },
  });
}
/** A no-client document cannot receive deferred settlements; resolve its public data before rendering. */
export async function resolveDeferred(
  value: unknown,
  seen = new Map<object, unknown>(),
): Promise<unknown> {
  value = await value;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const child of value) result.push(await resolveDeferred(child, seen));
    return result;
  }
  if (value instanceof Map) {
    const result = new Map();
    seen.set(value, result);
    for (const [key, child] of value)
      result.set(
        await resolveDeferred(key, seen),
        await resolveDeferred(child, seen),
      );
    return result;
  }
  if (value instanceof Set) {
    const result = new Set();
    seen.set(value, result);
    for (const child of value) result.add(await resolveDeferred(child, seen));
    return result;
  }
  if (
    Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null
  ) {
    const result: Data = {};
    seen.set(value, result);
    for (const [key, child] of Object.entries(value))
      Object.defineProperty(result, key, {
        value: await resolveDeferred(child, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return result;
  }
  return value;
}
