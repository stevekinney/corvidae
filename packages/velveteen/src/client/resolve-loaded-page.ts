import { createErrorPayload, getControl, LoadFailure } from "../data/errors.ts";
import { readDataResponse } from "../data/transport.ts";
import { assertRegistryPayload } from "../data/validate.ts";
import { loadRequest } from "../data/fetch.ts";
import { resolveBranch, runUniversalLoads } from "../data/loads.ts";
import type { Fetch, Invalidation, ResolvedPage } from "../data/contract.ts";
import type { ClientRegistry, Prepared } from "./types.ts";

export async function readLoadedPage(
  response: Response,
  registry: ClientRegistry,
  url: URL,
  base: string,
  controller: AbortController,
): Promise<Prepared> {
  const { payload, done } = await readDataResponse(
    response,
    controller.signal,
    registry.transport,
  );
  if (payload.prerendered) payload.url = url.href;
  assertRegistryPayload(payload, registry);
  if (payload.basePath !== base || new URL(payload.url).origin !== url.origin)
    throw new Error("Data response belongs to a different application");
  return { payload, done, controller };
}

export async function resolveLoadedPage(
  registry: ClientRegistry,
  prepared: Prepared,
  page: ResolvedPage,
  fetcher: Fetch,
  report: (error: unknown) => void,
  invalidation?: Invalidation,
): Promise<ResolvedPage> {
  if (prepared.resolved) return prepared.resolved;
  try {
    return await runUniversalLoads(registry, prepared.payload, {
      fetch: (input, init) =>
        fetcher(
          loadRequest(
            input,
            init,
            prepared.payload.url,
            prepared.controller.signal,
          ),
        ),
      signal: prepared.controller.signal,
      previous: page,
      invalidation,
    });
  } catch (error) {
    prepared.controller.signal.throwIfAborted();
    if (!(error instanceof LoadFailure)) throw error;
    const control = getControl(error.cause);
    if (control?.kind === "redirect") throw error.cause;
    const status = control?.kind === "error" ? control.status : 500,
      publicError =
        control?.kind === "error"
          ? control.error
          : { message: "Internal Error" };
    if (!control) report(error.cause);
    return resolveBranch(
      registry,
      createErrorPayload(
        prepared.payload,
        registry.manifest,
        status,
        publicError,
        error,
      ),
      error.partial,
    );
  }
}
