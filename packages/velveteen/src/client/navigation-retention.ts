import type { RenderNode, PagePayload } from "../data/contract.ts";

/**
 * A retained view is safe only when every rendered component in its branch is unchanged.
 * @internal
 */
export function sameRenderedBranch(
  current: RenderNode[],
  next: RenderNode[],
): boolean {
  if (current.length !== next.length) return false;
  return current.every((node, index) => {
    const candidate = next[index];
    return (
      candidate !== undefined &&
      node.component !== undefined &&
      candidate.component !== undefined &&
      node.component === candidate.component &&
      node.role === candidate.role
    );
  });
}

export function assertSameRenderedBranch(
  current: RenderNode[],
  next: RenderNode[],
): void {
  if (!sameRenderedBranch(current, next))
    throw new TypeError(
      "keepView navigation requires the same resolved component branch",
    );
}

/** Tracks opt-in page identities across a retained replacement and later ordinary navigations. */
export function createPageIdentity(
  pageKey: ((payload: PagePayload) => string) | undefined,
  initial: PagePayload,
) {
  let currentBase = pageKey?.(initial);
  let generation = 0;
  let current = encode(currentBase, generation);
  let retainedOrigin: string | undefined;
  function encode(base: string | undefined, value: number) {
    return base === undefined
      ? undefined
      : JSON.stringify(["velveteen", base, value]);
  }
  return {
    current() {
      return current;
    },
    commit(
      payload: PagePayload,
      {
        keepView = false,
        refresh = false,
      }: { keepView?: boolean; refresh?: boolean } = {},
    ) {
      if (refresh) return current;
      const nextBase = pageKey?.(payload);
      if (keepView) {
        if (pageKey === undefined)
          throw new TypeError("keepView navigation requires pageKey");
        retainedOrigin ??= currentBase;
        currentBase = nextBase;
        return current;
      }
      if (retainedOrigin !== undefined) {
        current = encode(
          nextBase,
          nextBase === retainedOrigin ? ++generation : 0,
        );
      } else if (nextBase !== currentBase) {
        generation = 0;
        current = encode(nextBase, generation);
      }
      currentBase = nextBase;
      retainedOrigin = undefined;
      return current;
    },
  };
}
