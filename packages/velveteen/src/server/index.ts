import { runAction } from "../actions/server.ts";
import { resolvePageOptions } from "./page-options.ts";
import { dispatchRemote } from "../remote/server.ts";
import { runRemoteForm } from "../remote/forms.ts";
import { matchRoute } from "../routing/match.ts";
import type {
  Data,
  PagePayload,
  PublicError,
  ResolvedPage,
} from "../data/contract.ts";
import { dataMediaType } from "../data/contract.ts";
import { runUniversalLoads, resolveBranch } from "../data/loads.ts";
import {
  createErrorPayload,
  error as httpError,
  getControl,
  LoadFailure,
} from "../data/errors.ts";
import { createCapturedFetch } from "../data/fetch.ts";
import { requestContext } from "./context.ts";
import { createEvent } from "./request.ts";
import { abortable, ownResponse } from "./lifetime.ts";
import { preparePage, runServerLoads } from "./loads.ts";
import { dataResponse, documentResponse } from "./responses.ts";
import { renderPage, resolveDeferred } from "./render.ts";
import { createRequestTrace } from "./tracing.ts";
import { dispatchMount, startMounts, validateMounts } from "./mounts.ts";
import type {
  AssetFetcher,
  AssetSource,
  ApplicationOptions,
  RequestEvent,
  ServerRegistry,
  ServerHooks,
} from "./types.ts";
export type {
  ApplicationOptions,
  AssetFetcher,
  AssetSource,
  RequestEvent,
  ServerHooks,
  ServerLoadEvent,
  FetchHandler,
  FetchService,
  FetchServiceGroup,
} from "./types.ts";
export type { RequestTraceSpan } from "./tracing.ts";
export { getRequestEvent } from "./context.ts";
export { error, redirect } from "../data/errors.ts";

type ServerHandle = NonNullable<ServerHooks["handle"]>;
const adoptMounts = Symbol("adopt mounts");
type AssetRoutes = Record<
  string,
  (request: Request) => Response | Promise<Response>
>;
type Application = {
  fetch(request: Request): Promise<Response>;
  routes: AssetRoutes;
  replaceGeneration(
    generation: ApplicationOptions["generation"],
    registry?: ServerRegistry,
  ): Promise<Application>;
  retire(): Promise<void>;
  dispose(): Promise<void>;
  [adoptMounts](): void;
};

/** Adapt a host's Fetch binding to Velveteen's production asset source. */
export const fetchAssetSource = (fetcher: AssetFetcher): AssetSource => ({
  get: (_url, request) => fetcher.fetch(request),
});

/** Compose server middleware in declaration order with nested post-processing. */
export function sequence(...handlers: ServerHandle[]): ServerHandle {
  if (handlers.length === 0) return ({ event, resolve }) => resolve(event);

  return ({ event, resolve }) => {
    const apply = async (
      index: number,
      current: RequestEvent,
    ): Promise<Response> => {
      const handle = handlers[index];
      return requestContext.run(current, () =>
        handle({
          event: current,
          resolve: (next = current) =>
            index + 1 < handlers.length
              ? apply(index + 1, next)
              : requestContext.run(next, () => resolve(next)),
        }),
      );
    };

    return apply(0, event);
  };
}

const dataRequest = (request: Request) =>
  request.headers
    .get("accept")
    ?.split(",")
    .some((type) => type.trim().split(";")[0] === dataMediaType) ?? false;
const htmlRequest = (request: Request) =>
  !request.headers.has("accept") ||
  request.headers.get("accept")!.includes("text/html") ||
  request.headers.get("accept") === "*/*";

/** The host owns its listener and injected ModuleGraph; the application owns requests until their bodies finish. */
export async function createApplication(options: ApplicationOptions) {
  const mounts =
    options.mounts &&
    Object.fromEntries(
      Object.entries(options.mounts).map(([path, declaration]) => [
        path,
        typeof declaration === "function" ? declaration : { ...declaration },
      ]),
    );
  return createGeneration({
    ...options,
    mounts,
  });
}

async function createGeneration(
  options: ApplicationOptions,
  inherited?: Awaited<ReturnType<typeof startMounts>>,
): Promise<Application> {
  const { generation, hooks } = options;
  const suppliedRegistry = options.registry;
  const suppliedAssets = options.assets;
  let registry: ServerRegistry = suppliedRegistry as ServerRegistry;
  if (!suppliedRegistry) {
    const path = await import("node:path");
    registry = await import(
      path.join(generation.directory, generation.manifest.server.file)
    );
  }
  let filesystemAssets: AssetRoutes | undefined;
  if (!suppliedAssets) {
    const serving = await import("../build/serving.ts");
    filesystemAssets = serving.createProductionAssetRoutes(generation);
  }
  const assets: AssetSource = suppliedAssets ?? {
    get: (url, request) => filesystemAssets![url.pathname]?.(request),
  };
  const assetUrls = new Set(
    generation.manifest.assets.map((asset) => asset.url),
  );
  const assetPaths = Object.fromEntries(
    generation.manifest.assets.map((asset) => [asset.url, true]),
  );
  const paths = validateMounts(options, registry, assetPaths);
  const owner = inherited ?? (await startMounts(options, paths));
  let ownsMounts = !inherited;
  let replacing = false;
  const active = new Set<AbortController>();
  let disposed = false;
  let retirement: PromiseWithResolvers<void> | undefined;
  try {
    await hooks?.init?.();
  } catch (error) {
    if (ownsMounts) await owner.close().catch(() => {});
    throw error;
  }
  const dispatch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
    parent?: AbortController,
  ): Promise<Response> => {
    const request =
      input instanceof Request && !init ? input : new Request(input, init);
    if (disposed) return new Response("Application disposed", { status: 503 });
    const contentType = request.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    const machineForm =
      request.method === "POST" &&
      contentType === "application/x-www-form-urlencoded" &&
      !request.headers.has("origin") &&
      !request.headers.has("cookie") &&
      owner.mounts.some((mount) =>
        mount.machineFormPaths.includes(new URL(request.url).pathname),
      );
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
      [
        "application/x-www-form-urlencoded",
        "multipart/form-data",
        "text/plain",
      ].includes(contentType ?? "") &&
      !machineForm &&
      request.headers.get("origin") !== new URL(request.url).origin
    ) {
      return new Response("Cross-origin form requests are forbidden", {
        status: 403,
      });
    }
    const requestUrl = new URL(request.url);
    if (assetUrls.has(requestUrl.pathname)) {
      const asset = await assets.get(requestUrl, request);
      if (asset) return asset;
    }
    if (retirement && (!parent || !active.has(parent)))
      return new Response("Application retiring", { status: 503 });
    const controller = new AbortController();
    active.add(controller);
    const abort = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
    const release = () => {
      active.delete(controller);
      owner.active.delete(controller);
      if (active.size === 0) retirement?.resolve();
      request.signal.removeEventListener("abort", abort);
    };
    const url = requestUrl,
      base = generation.manifest.basePath;
    const context = createEvent(
      request,
      url,
      controller.signal,
      (internalInput, internalOptions) =>
        dispatch(internalInput, internalOptions, controller),
      options,
    );
    const trace = createRequestTrace(options.onTrace, context.event);
    let payload: PagePayload = {
      version: 1,
      url: url.href,
      basePath: base,
      stylesheets: [],
      routeId: null,
      params: {},
      status: 404,
      error: { message: "Not Found" },
      options: { ssr: true, csr: true },
      nodes: [],
      branch: [{ node: null, role: "error" }],
      fetched: [],
    };
    const reroutedEvents = new WeakSet<RequestEvent>();
    let page: ResolvedPage | undefined;
    const isData = dataRequest(request);
    const publicError = async (
      cause: unknown,
      event: RequestEvent,
    ): Promise<{ status: number; error: PublicError }> => {
      const control = getControl(cause);
      if (control?.kind === "error")
        return { status: control.status, error: control.error };
      try {
        const reported = await hooks?.handleError?.({
          event,
          error: cause,
          status: 500,
          message: "Internal Error",
        });
        return {
          status: 500,
          error: reported ?? { message: "Internal Error" },
        };
      } catch {
        return { status: 500, error: { message: "Internal Error" } };
      }
    };
    const respond = async (event: RequestEvent) => {
      if (isData)
        return dataResponse(payload, {
          signal: controller.signal,
          transport: registry.transport,
        });
      if (!htmlRequest(request))
        return new Response("Not Acceptable", { status: 406 });
      let rendered = { body: "", head: "" };
      if (payload.options.ssr) {
        if (!payload.options.csr) {
          for (const node of payload.nodes)
            node.data = (await resolveDeferred(node.data)) as Data;
          page = undefined;
        }
        page ??= await runUniversalLoads(registry, payload, {
          fetch: createCapturedFetch(
            event.fetch,
            event.url.href,
            payload.fetched,
            {
              signal: controller.signal,
              filterHeader: options.filterSerializedResponseHeaders,
            },
          ),
          signal: controller.signal,
          setHeaders: event.setHeaders,
          observeLoad: trace?.loads("universal.load", event),
        });
        rendered = renderPage(registry, page);
      }
      return documentResponse({
        payload,
        rendered,
        template: options.template,
        registryUrl: generation.manifest.client.url,
        transport: registry.transport,
        signal: controller.signal,
      });
    };
    const failed = async (
      failure: unknown,
      event: RequestEvent,
    ): Promise<Response> => {
      const cause = failure instanceof LoadFailure ? failure.cause : failure;
      const control = getControl(cause);
      if (control?.kind === "redirect") {
        const destination = new URL(control.location, event.url);
        if (!["http:", "https:"].includes(destination.protocol))
          throw new TypeError("Invalid redirect protocol");
        if (!isData)
          return new Response(null, {
            status: control.status,
            headers: { location: destination.href },
          });
        return dataResponse(
          {
            ...payload,
            status: control.status,
            redirect: destination.href,
            nodes: [],
            branch: [],
          },
          { signal: controller.signal, transport: registry.transport },
        );
      }
      const report = await publicError(cause, event);
      if (!isData && !htmlRequest(request))
        return Response.json(report.error, { status: report.status });
      payload = createErrorPayload(
        payload,
        registry.manifest,
        report.status,
        report.error,
        failure instanceof LoadFailure ? failure : undefined,
      );
      page =
        failure instanceof LoadFailure && failure.partial.length
          ? await resolveBranch(registry, payload, failure.partial)
          : undefined;
      try {
        return await respond(event);
      } catch {
        // A broken error component cannot recursively select itself.
        payload = {
          ...payload,
          status: 500,
          error: { message: "Internal Error" },
          nodes: [],
          branch: [{ node: null, role: "error" }],
        };
        page = await resolveBranch(registry, payload, []);
        return respond(event);
      }
    };
    const findRoute = async (event: RequestEvent) => {
      let pathname = event.url.pathname;
      const rerouted = await hooks?.reroute?.({
        url: new URL(event.url),
        fetch: event.fetch,
      });
      if (rerouted !== undefined) {
        const target = new URL(rerouted, event.url);
        if (target.origin !== url.origin)
          throw new TypeError("Reroute must remain on the same origin");
        if (target.pathname !== pathname) reroutedEvents.add(event);
        pathname = target.pathname;
      }
      if (base && pathname !== base && !pathname.startsWith(`${base}/`))
        return null;
      try {
        return matchRoute(
          registry.manifest,
          pathname.slice(base.length) || "/",
          registry.matchers,
        );
      } catch (cause) {
        if (cause instanceof URIError) httpError(400, "Malformed URL");
        throw cause;
      }
    };
    let preparedMatch: Awaited<ReturnType<typeof findRoute>>;
    const resolve = async (
      event: RequestEvent = context.event,
    ): Promise<Response> => {
      try {
        if (machineForm && event.request !== request)
          return new Response("Cross-origin form requests are forbidden", {
            status: 403,
          });
        const mounted = dispatchMount(
          owner.mounts,
          base,
          event.request,
          controller.signal,
          owner.closed,
        );
        if (mounted !== undefined) {
          owner.active.add(controller);
          return await mounted;
        }
        if (event.url.pathname.startsWith(`${base}/_remote/`)) {
          return dispatchRemote(options.remotes ?? {}, request, event, {
            publicError,
          });
        }
        const matched =
          event === context.event ? preparedMatch : await findRoute(event);
        if (matched === null) return new Response("Not Found", { status: 404 });
        if (!matched) return respond(event);
        event.params = matched.params;
        event.route = { id: matched.route.id };
        const route = matched.route;
        const routeOptions = await resolvePageOptions(registry, route);
        const pathname = event.url.pathname;
        const canonical =
          routeOptions.trailingSlash === "always" && !pathname.endsWith("/")
            ? `${pathname}/`
            : routeOptions.trailingSlash === "never" &&
                pathname.endsWith("/") &&
                pathname !== `${base}/`
              ? pathname.slice(0, -1)
              : pathname;
        if (canonical !== pathname) {
          const destination = new URL(event.url);
          destination.pathname = canonical;
          return new Response(null, {
            status: 308,
            headers: { location: destination.href },
          });
        }
        const hasRemoteForm = event.url.searchParams.has("/remote");
        const isAction =
          request.method === "POST" &&
          route.leaf !== undefined &&
          (hasRemoteForm ||
            htmlRequest(request) ||
            request.headers.get("x-velveteen-action") === "true");
        if (
          route.endpoint &&
          !isAction &&
          (route.leaf === undefined ||
            !["GET", "HEAD"].includes(request.method) ||
            (!isData && !htmlRequest(request)))
        ) {
          const module = await registry.nodes[route.node].endpoint!();
          const methods = Object.keys(module).filter((name) =>
            /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(name),
          );
          if (methods.includes("GET") && !methods.includes("HEAD"))
            methods.push("HEAD");
          if (!methods.includes("OPTIONS")) methods.push("OPTIONS");
          const handler =
            module[request.method] ??
            (request.method === "HEAD" ? module.GET : undefined);
          if (request.method === "OPTIONS" && !handler)
            return new Response(null, {
              status: 204,
              headers: { allow: methods.join(", ") },
            });
          if (typeof handler !== "function")
            return new Response("Method Not Allowed", {
              status: 405,
              headers: { allow: methods.join(", ") },
            });
          const result: unknown = await handler(event);
          if (!(result instanceof Response))
            throw new TypeError("Endpoint must return a Response");
          return result;
        }
        if (!["GET", "HEAD"].includes(request.method) && !isAction)
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { allow: "GET, HEAD" },
          });
        const prepared = await preparePage(
          registry,
          route,
          event,
          base,
          generation.manifest.routes[route.id]?.stylesheets ?? [],
        );
        payload = prepared.payload;
        if (options.prerendering) payload.prerendered = true;
        if (isAction) {
          const action = async () => {
            if (hasRemoteForm)
              return runRemoteForm(options.remoteForms ?? {}, event);
            const module = await registry.nodes[route.leaf!].pageServer?.();
            return runAction(module?.actions, event);
          };
          const result = await (trace ? trace.action(event, action) : action());
          payload.form = result.data ?? null;
          payload.status = result.status;
        }
        if (isData || payload.options.ssr) {
          let selection: string[] | undefined;
          if (isData && request.headers.has("x-velveteen-loads")) {
            try {
              const parsed: unknown = JSON.parse(
                request.headers.get("x-velveteen-loads")!,
              );
              if (
                !Array.isArray(parsed) ||
                !parsed.every((key) => typeof key === "string")
              )
                throw new TypeError();
              if (!reroutedEvents.has(event)) {
                if (
                  parsed.some(
                    (key) => !payload.nodes.some((node) => node.key === key),
                  )
                )
                  throw new TypeError();
                selection = parsed;
              }
            } catch {
              return new Response("Invalid load selection", { status: 400 });
            }
          }
          await runServerLoads(
            payload,
            prepared.modules,
            event,
            selection,
            trace?.loads("server.load", event),
          );
        }
        return await respond(event);
      } catch (error) {
        return failed(error, event);
      }
    };
    try {
      const response = await abortable(
        requestContext.run(context.event, async () => {
          try {
            preparedMatch = context.event.url.pathname.startsWith(
              `${base}/_remote/`,
            )
              ? null
              : await findRoute(context.event);
            if (preparedMatch) {
              context.event.params = preparedMatch.params;
              context.event.route = { id: preparedMatch.route.id };
            }
            return await (hooks?.handle?.({
              event: context.event,
              resolve: (event = context.event) =>
                requestContext.run(event, () => resolve(event)),
            }) ?? resolve());
          } catch (error) {
            return failed(error, context.event);
          }
        }),
        controller.signal,
      );
      const owned = context.apply(response);
      const status =
        isData && owned.headers.get("content-type")?.startsWith(dataMediaType)
          ? payload.status
          : owned.status;
      return ownResponse(
        owned,
        controller,
        release,
        request.method === "HEAD",
        trace && ((outcome) => trace.finish(outcome, status, payload.routeId)),
      );
    } catch (error) {
      const canceled = controller.signal.aborted;
      controller.abort(error);
      trace?.finish(
        canceled ? "canceled" : "error",
        undefined,
        payload.routeId,
      );
      release();
      throw error;
    }
  };
  return {
    fetch: (request: Request) => dispatch(request),
    routes: filesystemAssets ?? {},
    async replaceGeneration(
      nextGeneration: ApplicationOptions["generation"],
      nextRegistry?: ServerRegistry,
    ) {
      if (!ownsMounts || disposed || retirement || replacing)
        throw new Error("Application cannot replace generation");
      replacing = true;
      try {
        const next = await createGeneration(
          { ...options, generation: nextGeneration, registry: nextRegistry },
          owner,
        );
        if (disposed || retirement)
          throw new Error("Application cannot replace generation");
        ownsMounts = false;
        next[adoptMounts]();
        return next;
      } finally {
        replacing = false;
      }
    },
    [adoptMounts]() {
      ownsMounts = true;
    },
    retire() {
      retirement ??= Promise.withResolvers<void>();
      if (active.size === 0) retirement.resolve();
      return retirement.promise;
    },
    async dispose() {
      disposed = true;
      for (const controller of active)
        controller.abort(
          new DOMException("Application disposed", "AbortError"),
        );
      if (ownsMounts) await owner.close();
    },
  };
}
