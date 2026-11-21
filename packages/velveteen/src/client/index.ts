import type {
  ClientOptions,
  ClientApplication,
  ClientRegistry,
  NavigationOptions,
  Prepared,
} from "./types.ts";
import { enhance as enhanceForm } from "../actions/enhance.ts";
import { hydrate, mount, unmount, tick } from "svelte";
import { listenNavigation } from "./events.ts";
import { createErrorPayload, getControl } from "../data/errors.ts";
import { createReplayFetch } from "../data/fetch.ts";
import { runUniversalLoads, resolveBranch } from "../data/loads.ts";
import { assertRegistryPayload } from "../data/validate.ts";
import type {
  ApplicationState,
  Fetch,
  Invalidation,
  NavigationEvent,
  NavigationProtocol,
} from "../data/contract.ts";
import { dataMediaType } from "../data/contract.ts";
import { createState } from "./state.svelte.ts";
import { readInitialDocument } from "./document.ts";
import { ensureStylesheets } from "./styles.ts";
import { selectServerLoads } from "./load-selection.ts";
import { createHistory } from "./history.ts";
import { createNavigationHooks } from "./navigation-hooks.ts";
import { readLoadedPage, resolveLoadedPage } from "./resolve-loaded-page.ts";
import { createPreloads } from "./preloads.ts";
import {
  assertSameRenderedBranch,
  createPageIdentity,
} from "./navigation-retention.ts";
import { matchRoute } from "../routing/match.ts";
import { createSnapshots } from "./snapshots.ts";
import { createInvalidationHandlers } from "./invalidation.ts";
export async function startClient(
  registry: ClientRegistry,
  options: ClientOptions = {},
): Promise<ClientApplication> {
  const target = options.target ?? document.querySelector("#app");
  if (!target) throw new Error("Missing application target");
  const fetcher: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const documentData = options.initial
    ? undefined
    : readInitialDocument(document, registry.transport);
  let initial = options.initial ?? documentData!.payload;
  const capturedBaseURL = initial.prerendered ? initial.url : undefined;
  if (initial.prerendered) initial = { ...initial, url: location.href };
  assertRegistryPayload(initial, registry);
  const initialController = new AbortController();
  let disposed = false,
    version = 0,
    active = initialController,
    pending: AbortController | undefined,
    currentUrl = new URL(initial.url),
    addressUrl = new URL(initial.url);
  const base = initial.basePath;
  const snapshots = createSnapshots(base, registry.transport);
  const inside = (url: URL) =>
    url.origin === location.origin &&
    (!base || url.pathname === base || url.pathname.startsWith(`${base}/`));
  const resolveUrl = (value: string | URL) => new URL(value, addressUrl);
  const navigation = {} as NavigationProtocol;
  const report = (error: unknown, index = -1) => {
    if (!disposed) {
      if (options.onError) options.onError(error, index);
      else console.error(error);
    }
  };
  let transportFailure: unknown;
  let failTransport = (error: unknown) => {
    transportFailure = error;
  };
  documentData?.activate((error) => failTransport(error));
  const cleanupStartupFailure = (error: unknown): never => {
    documentData?.dispose();
    initialController.abort(error);
    throw error;
  };
  const observed = (work: Prepared) => {
    void work.done.catch((error) => {
      if (!work.controller.signal.aborted && active === work.controller)
        failTransport(error);
    });
    return work;
  };
  async function read(
    url: URL,
    controller: AbortController,
    keys?: string[],
    submission?: RequestInit,
  ): Promise<Prepared> {
    const headers = new Headers(submission?.headers);
    headers.set("accept", dataMediaType);
    if (submission) headers.set("x-velveteen-action", "true");
    if (keys) headers.set("x-velveteen-loads", JSON.stringify(keys));
    const signal = submission?.signal
      ? AbortSignal.any([submission.signal, controller.signal])
      : controller.signal;
    const response = await fetcher(url, { ...submission, headers, signal });
    return observed(
      await readLoadedPage(response, registry, url, base, controller),
    );
  }
  let page: Awaited<ReturnType<typeof runUniversalLoads>>;
  try {
    if (!initial.options.ssr && initial.options.csr && options.csr !== false) {
      const initialResponse = await read(currentUrl, initialController);
      initial = initialResponse.payload;
    }
    const initialFetch = createReplayFetch(
      initial.fetched,
      initial.url,
      fetcher,
      initialController.signal,
      initial.prerendered ? capturedBaseURL : undefined,
    );
    page = await runUniversalLoads(registry, initial, {
      fetch: initialFetch,
      signal: initialController.signal,
    });
  } catch (error) {
    return cleanupStartupFailure(error);
  }
  const pageIdentity = createPageIdentity(options.pageKey, initial);
  const state: ApplicationState = createState(
    page,
    (error, index) => {
      report(error, index);
      const node = state.page.branch[index];
      if (!node || node.node === null || node.role === "error") return;
      const expected = state.page;
      const failed = createErrorPayload(
        expected.payload,
        registry.manifest,
        500,
        { message: "Internal Error" },
        { node: node.node, role: node.role },
      );
      void showRenderError();
      async function showRenderError() {
        try {
          const next = await resolveBranch(registry, failed, expected.loads);
          if (!disposed && state.page === expected) {
            page = next;
            state.page = next;
          }
        } catch (renderError) {
          report(renderError);
        }
      }
    },
    pageIdentity.current(),
  );
  failTransport = (error) => {
    if (disposed) return;
    version++;
    active.abort(error);
    const payload = {
      ...page.payload,
      status: 500,
      error: { message: "Invalid page data" },
      nodes: [],
      branch: [{ node: null, role: "error" as const }],
    };
    page = {
      payload,
      loads: [],
      branch: [{ node: null, role: "error", data: {} }],
    };
    state.page = page;
    report(error);
  };
  if (transportFailure) failTransport(transportFailure);
  Object.assign(state, { navigation, registerSnapshot: snapshots.register });
  const hooks = createNavigationHooks(options);
  state.registerNavigationHook = hooks.register;
  if (!initial.options.csr || options.csr === false) {
    const unavailable = async () => {
      throw new Error("Client navigation is disabled");
    };
    Object.assign(navigation, {
      enhance: () => {
        throw new Error("Client navigation is disabled");
      },
      goto: unavailable,
      preloadCode: unavailable,
      preloadData: unavailable,
      invalidate: unavailable,
      invalidateAll: unavailable,
      refreshAll: unavailable,
    });
    documentData?.dispose();
    return {
      ...navigation,
      state,
      async dispose() {
        disposed = true;
        initialController.abort();
      },
    };
  }
  const shouldHydrate =
    initial.options.ssr &&
    options.ssr !== false &&
    target.childNodes.length > 0;
  let instance: ReturnType<typeof mount>;
  try {
    await ensureStylesheets(initial.stylesheets, initialController.signal);
    instance = shouldHydrate
      ? hydrate(registry.Root, { target, recover: false, props: { state } })
      : mount(registry.Root, { target, props: { state } });
  } catch (error) {
    return cleanupStartupFailure(error);
  }
  const historyOwner = createHistory();
  const removeSnapshotPersistence = snapshots.attach(
    historyOwner.current,
    report,
  );
  const selection = (url: URL, invalidation?: Invalidation) =>
    selectServerLoads(registry, page, url, base, invalidation);
  const preloads = createPreloads(registry, {
    resolveUrl,
    inside,
    disposed: () => disposed,
    read: (url, controller) => read(url, controller, selection(url)),
    resolve: (prepared) =>
      resolveLoadedPage(registry, prepared, page, fetcher, report),
  });
  const { preloadCode, preloadData } = preloads;
  async function request(
    url: URL,
    settings: NavigationOptions = {},
  ): Promise<void> {
    if (disposed) return;
    if (settings.keepView && !settings.replace)
      throw new TypeError("keepView navigation requires replace: true");
    if (!["http:", "https:"].includes(url.protocol))
      throw new TypeError("Invalid navigation URL");
    if (!inside(url)) {
      if (settings.shallow)
        throw new TypeError("Shallow navigation requires an application URL");
      location.assign(url.href);
      return;
    }
    const address = settings.pop ? new URL(location.href) : url;
    const renderedUrl = settings.shallow
      ? currentUrl.href
      : settings.pop?.renderedUrl;
    const matchedUrl = matchRoute(
      registry.manifest,
      address.pathname.slice(base.length) || "/",
      registry.matchers,
    );
    const historyUrl = renderedUrl ? matchedUrl : undefined;
    if (settings.shallow && !historyUrl)
      throw new Error(
        `Cannot shallow navigate to an unknown route: ${address}`,
      );
    const shallow = renderedUrl
      ? {
          url: address,
          params: historyUrl?.params ?? {},
          routeId: historyUrl?.route.id ?? null,
        }
      : undefined;
    const sameView = historyOwner.isRenderedView(settings.pop);
    const silentPop = sameView && (!shallow || address.href === url.href);
    const event: NavigationEvent = {
      from: currentUrl,
      to: address,
      type: settings.type ?? "goto",
      shallow: shallow !== undefined,
      params: matchedUrl?.params ?? null,
      routeId: matchedUrl?.route.id ?? null,
    };
    const runHooks = !settings.refresh && !silentPop;
    const stageSnapshot = () =>
      !settings.refresh && !settings.replace
        ? snapshots.stage(historyOwner.current())
        : undefined;
    const commitHistory = (
      destination: URL,
      entryState: Record<string, unknown>,
      historyAddress?: string,
    ) => {
      historyOwner.commit(destination, {
        ...settings,
        renderedUrl: historyAddress,
        state: entryState,
      });
      if (!settings.refresh && !settings.pop)
        snapshots.discard(historyOwner.current(), settings.replace === true);
    };
    if (runHooks && hooks.canceled(event)) {
      if (settings.pop) historyOwner.revert(settings.pop);
      return;
    }
    if (!settings.refresh) historyOwner.save();
    const sequence = ++version;
    if (settings.shallow || sameView) {
      pending?.abort(new DOMException("Superseded navigation", "AbortError"));
      const storeSnapshot = stageSnapshot();
      const preparation = runHooks ? hooks.prepare(event) : undefined;
      const complete = preparation ? await preparation : undefined;
      if (sequence !== version || disposed) return;
      const entryState =
        settings.pop?.state ?? structuredClone(settings.state ?? {});
      commitHistory(address, entryState, renderedUrl);
      storeSnapshot?.();
      addressUrl = address;
      state.shallow = shallow;
      state.state = entryState;
      await tick();
      if (sequence !== version || disposed) return;
      historyOwner.restore(address, {
        ...settings,
        noScroll: settings.noScroll ?? !settings.pop,
        keepFocus: settings.keepFocus ?? true,
      });
      if (runHooks) hooks.finish(event, complete);
      if (settings.pop && sequence === version)
        snapshots.restore(historyOwner.current());
      return;
    }
    const previousController = active;
    const cached =
      !settings.submission && !settings.refresh && !settings.invalidateAll
        ? preloads.take(url)
        : undefined;
    const controller = cached?.controller ?? new AbortController();
    active = pending = controller;
    const submissionSignal = settings.submission?.signal;
    const abortSubmission = () => controller.abort(submissionSignal?.reason);
    if (submissionSignal?.aborted) abortSubmission();
    else
      submissionSignal?.addEventListener("abort", abortSubmission, {
        once: true,
      });
    previousController.abort(
      new DOMException("Superseded navigation", "AbortError"),
    );
    documentData?.dispose();
    const invalidation = settings.invalidateAll ? "all" : settings.invalidation;
    if (settings.refresh || invalidation) preloads.clear();
    try {
      const prepared = cached
        ? await cached.work
        : await read(
            url,
            controller,
            settings.submission ? undefined : selection(url, invalidation),
            settings.submission,
          );
      controller.signal.throwIfAborted();
      if (sequence !== version) return;
      if (prepared.payload.redirect) {
        await request(new URL(prepared.payload.redirect, url), {
          ...settings,
          submission: undefined,
        });
        return;
      }
      if (!prepared.payload.options.csr) {
        location.assign(url.href);
        return;
      }
      const resolved = await resolveLoadedPage(
        registry,
        prepared,
        page,
        fetcher,
        report,
        invalidation,
      );
      event.params = resolved.payload.params;
      event.routeId = resolved.payload.routeId;
      await ensureStylesheets(resolved.payload.stylesheets, controller.signal);
      controller.signal.throwIfAborted();
      if (sequence !== version) return;
      if (settings.keepView)
        assertSameRenderedBranch(page.branch, resolved.branch);
      if (settings.submission) {
        url = new URL(url);
        for (const key of Array.from(url.searchParams.keys()))
          if (key.startsWith("/")) url.searchParams.delete(key);
        event.to = url;
      }
      const storeSnapshot = stageSnapshot();
      const preparation = runHooks ? hooks.prepare(event) : undefined;
      const complete = preparation ? await preparation : undefined;
      controller.signal.throwIfAborted();
      if (sequence !== version || disposed) return;
      const entryState =
        settings.pop?.state ?? structuredClone(settings.state ?? {});
      const nextPageKey = pageIdentity.commit(resolved.payload, settings);
      commitHistory(settings.pop ? address : url, entryState);
      storeSnapshot?.();
      page = resolved;
      state.page = resolved;
      if (options.pageKey) state.pageKey = nextPageKey;
      currentUrl = url;
      if (!settings.refresh) {
        addressUrl = settings.pop ? address : url;
        state.shallow = shallow;
        state.state = entryState;
      }
      pending = undefined;
      preloads.clear();
      await tick();
      if (sequence !== version || disposed) return;
      historyOwner.restore(addressUrl, settings);
      if (runHooks) hooks.finish(event, complete);
      if (settings.pop && sequence === version)
        snapshots.restore(historyOwner.current());
    } catch (error) {
      if (controller.signal.aborted || sequence !== version) return;
      const control = getControl(error);
      if (control?.kind === "redirect") {
        await request(new URL(control.location, url), {
          ...settings,
          submission: undefined,
        });
        return;
      }
      report(error);
      throw error;
    } finally {
      if (pending === controller) pending = undefined;
      submissionSignal?.removeEventListener("abort", abortSubmission);
    }
  }
  const goto = (value: string | URL, settings: NavigationOptions = {}) =>
    request(resolveUrl(value), settings);
  const { invalidate, invalidateAll } = createInvalidationHandlers({
    currentUrl: () => currentUrl,
    addressUrl: () => addressUrl,
    request,
  });
  const forms = new Set<() => void>();
  const enhance = (form: HTMLFormElement) => {
    if (disposed) throw new Error("Client disposed");
    const dispose = enhanceForm(form, {
      onError: report,
      submit: async (url, submission) => {
        const sequence = version + 1;
        await request(url, {
          submission,
          invalidation: "all",
          replace: url.pathname === currentUrl.pathname,
        });
        if (disposed || submission.signal?.aborted || sequence !== version)
          return { type: "failure", status: 409, data: {} };
        return {
          type: page.payload.status < 400 ? "success" : "failure",
          status: page.payload.status,
          data: page.payload.form ?? {},
        };
      },
    });
    forms.add(dispose);
    return {
      destroy() {
        forms.delete(dispose);
        dispose();
      },
    };
  };
  Object.assign(navigation, {
    enhance,
    goto,
    preloadCode,
    preloadData,
    invalidate,
    invalidateAll,
    refreshAll: invalidateAll,
  });
  const removeListeners = listenNavigation({
    registry,
    base,
    inside,
    preloadData,
    preloadCode,
    report,
    link: (url) => request(url, { type: "link" }),
    pop: async (value) => {
      const pop = historyOwner.pop(value);
      if (pop)
        await request(new URL(pop.renderedUrl ?? location.href), {
          type: "popstate",
          pop,
        });
    },
  });
  await tick();
  if (version === 0) hooks.enter(currentUrl);
  if (version === 0) snapshots.restore(historyOwner.current());
  return {
    ...navigation,
    state,
    async dispose() {
      if (disposed) return;
      disposed = true;
      version++;
      active.abort(new DOMException("Client disposed", "AbortError"));
      initialController.abort();
      preloads.clear();
      documentData?.dispose();
      historyOwner.dispose();
      removeSnapshotPersistence();
      snapshots.dispose();
      removeListeners();
      for (const dispose of forms) dispose();
      forms.clear();
      await unmount(instance);
    },
  };
}
