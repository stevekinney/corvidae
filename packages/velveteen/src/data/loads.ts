import type {
  Data,
  Fetch,
  PagePayload,
  ResolvedPage,
  RuntimeRegistry,
  UniversalResult,
  Invalidation,
  RenderNode,
} from "./contract.ts";
import { assertRegistryPayload } from "./validate.ts";
import { LoadFailure } from "./errors.ts";
import { emptyUses, trackLoad, shouldRerun } from "./tracking.ts";
export type LoadObserver = <Value>(
  key: string,
  operation: () => Value | Promise<Value>,
) => Promise<Value>;
export { emptyUses, trackLoad, shouldRerun, loadKey } from "./tracking.ts";

export function loadOutput(value: unknown): Data {
  if (value === undefined) return {};
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new TypeError("Load must return a plain object or undefined");
  return value as Data;
}
/** Merge load results into component props, keeping the layout chain's incremental data boundaries. */
export async function resolveBranch(
  registry: RuntimeRegistry,
  payload: PagePayload,
  loads: UniversalResult[],
): Promise<ResolvedPage> {
  assertRegistryPayload(payload, registry);
  let data: Data = {};
  const byNode = new Map<string, Data>();
  for (const node of payload.nodes) {
    data = {
      ...data,
      ...(loads.find((load) => load.key === node.key)?.data ?? node.data),
    };
    byNode.set(node.key, data);
  }
  const branch: RenderNode[] = await Promise.all(
    payload.branch.map(async (entry) => {
      const entryData =
        entry.role === "error"
          ? data
          : (byNode.get(`${entry.node}:${entry.role}`) ?? {});
      const module =
        entry.node === null
          ? undefined
          : await registry.nodes[entry.node][entry.role]!();
      return { ...entry, data: entryData, component: module?.default };
    }),
  );
  return { payload, branch, loads };
}
/** Universal loads run concurrently; only an explicit parent() introduces a data dependency. */
export async function runUniversalLoads(
  registry: RuntimeRegistry,
  payload: PagePayload,
  options: {
    fetch: Fetch;
    signal: AbortSignal;
    previous?: ResolvedPage;
    invalidation?: Invalidation;
    setHeaders?: (headers: Record<string, string>) => void;
    observeLoad?: LoadObserver;
  },
): Promise<ResolvedPage> {
  assertRegistryPayload(payload, registry);
  const previous = options.previous;
  payload = {
    ...payload,
    nodes: payload.nodes.map((node) => {
      if (!node.skip) return node;
      const old = previous?.payload.nodes.find(
        (entry) => entry.key === node.key,
      );
      return old ? { ...node, data: old.data, uses: old.uses } : node;
    }),
  };
  const results: UniversalResult[] = [];
  const changed: boolean[] = [];
  for (const [index, node] of payload.nodes.entries()) {
    const old = previous?.loads.find((load) => load.key === node.key);
    changed[index] =
      !old ||
      !previous ||
      !node.skip ||
      shouldRerun(
        old.uses,
        previous.payload,
        payload,
        options.invalidation,
        changed.slice(0, index).some(Boolean),
      );
  }
  const promises = payload.nodes.map(
    async (node, index): Promise<UniversalResult> => {
      await Promise.resolve();
      options.signal.throwIfAborted();
      const loader =
        registry.nodes[node.node][
          node.role === "layout" ? "layoutUniversal" : "pageUniversal"
        ];
      const module = await loader?.();
      const old = previous?.loads.find((load) => load.key === node.key);
      if (old && !changed[index]) return old;
      const base = {
        url: new URL(payload.url),
        params: payload.params,
        route: { id: payload.routeId },
        data: node.data,
        signal: options.signal,
        fetch: options.fetch,
        parent: async () => {
          const ancestors = await Promise.all(promises.slice(0, index));
          return ancestors.reduce(
            (parent, ancestor) => ({ ...parent, ...ancestor.data }),
            {} as Data,
          );
        },
        depends: () => {},
        untrack: <Value>(operation: () => Value) => operation(),
        setHeaders: options.setHeaders ?? (() => {}),
      };
      const { event, uses } = trackLoad(base);
      event.fetch = async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          payload.url,
        );
        event.depends(url.href);
        return options.fetch(input, init);
      };
      try {
        const load = module?.load;
        const execute = load && (async () => loadOutput(await load(event)));
        const data = execute
          ? await (options.observeLoad
              ? options.observeLoad(node.key, execute)
              : execute())
          : node.data;
        options.signal.throwIfAborted();
        return { key: node.key, data, uses: load ? uses : emptyUses() };
      } catch (cause) {
        options.signal.throwIfAborted();
        throw new LoadFailure(node.node, node.role, cause);
      }
    },
  );
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(options.signal.reason);
  options.signal.addEventListener("abort", abort, { once: true });
  let settled: PromiseSettledResult<UniversalResult>[];
  try {
    if (options.signal.aborted) abort();
    settled = await Promise.race([
      Promise.allSettled(promises),
      aborted.promise,
    ]);
  } finally {
    options.signal.removeEventListener("abort", abort);
  }
  for (const result of settled)
    if (result.status === "fulfilled") results.push(result.value);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    if (failed.reason instanceof LoadFailure)
      throw new LoadFailure(
        failed.reason.node,
        failed.reason.role,
        failed.reason.cause,
        results,
      );
    throw failed.reason;
  }
  return resolveBranch(registry, payload, results);
}
