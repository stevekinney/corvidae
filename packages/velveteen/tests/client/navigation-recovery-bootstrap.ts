import { readDataResponse } from "../../src/data/transport.ts";
import { dataMediaType } from "../../src/data/contract.ts";
import type {
  ClientApplication,
  ClientOptions,
} from "../../src/client/types.ts";

declare const recoveryRegistryUrl: string;
declare const recoveryDataHeader: string;
export const recoveryStorageKey = "velveteen-fixture-chunk-reload";
export type RecoveryProbe = {
  application?: ClientApplication;
  errors: string[];
};
declare global {
  var recoveryProbe: RecoveryProbe;
  var confirmRecoveryData: ((marker: string) => Promise<void>) | undefined;
}

const probe: RecoveryProbe = { errors: [] };
globalThis.recoveryProbe = probe;
let destination = new URL(location.href);
let reloading = false;
const status = document.querySelector<HTMLElement>("[data-recovery-status]")!;

// Application policy: commit a guard before one document navigation, or expose
// failure when storage/offline state cannot safely support recovery.
function failed(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  probe.errors.push(message);
  if (reloading) return;
  const missing =
    /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/.test(
      message,
    );
  if (missing && navigator.onLine) {
    try {
      if (!sessionStorage.getItem(recoveryStorageKey)) {
        sessionStorage.setItem(recoveryStorageKey, "attempted");
        reloading = true;
        location.assign(destination.href);
        return;
      }
    } catch {
      // Unavailable storage cannot provide the cross-document guard.
    }
  }
  status.textContent = `Navigation failed: ${message}`;
  status.dataset.failed = "true";
}

function completed() {
  try {
    sessionStorage.removeItem(recoveryStorageKey);
  } catch {
    // Completion is valid even when browser storage is unavailable.
  }
  status.textContent = "Ready";
  delete status.dataset.failed;
}

async function fetchFixtureData(
  input: RequestInfo | URL,
  options?: RequestInit,
) {
  const headers = new Headers(
    options?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  if (!headers.get("accept")?.includes(dataMediaType))
    return fetch(input, options);
  const marker = crypto.randomUUID();
  headers.set(recoveryDataHeader, marker);
  const response = await fetch(input, { ...options, headers });
  const body = await response.arrayBuffer();
  // Confirm the network event before the fixture can replace this document.
  await globalThis.confirmRecoveryData?.(marker);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

try {
  const registry: {
    start(options: ClientOptions): Promise<ClientApplication>;
  } = await import(recoveryRegistryUrl);
  const initial = await readDataResponse(
    await fetchFixtureData(location.href, {
      headers: { accept: dataMediaType },
    }),
  );
  // This fixture has no deferred data. Finish its owned transport even when
  // loading the initial component is about to fail.
  await initial.done;
  probe.application = await registry.start({
    initial: initial.payload,
    // Mount into the fixture's empty shell using the real initial response.
    ssr: false,
    fetch: fetchFixtureData,
    beforeNavigate({ to }) {
      destination = to;
      status.textContent = "Loading";
    },
    afterNavigate: completed,
    onError: failed,
  });
  completed();
} catch (cause) {
  failed(cause);
}
