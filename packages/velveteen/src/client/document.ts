import { createDecoder } from "../data/codec.ts";
import { assertPayload } from "../data/validate.ts";
import { dataElementId } from "../data/contract.ts";
import type { PagePayload } from "../data/contract.ts";
import type { Transport } from "../data/custom-transport.ts";

export type DocumentSession = {
  payload: PagePayload;
  activate(onError?: (error: unknown) => void): void;
  dispose(): void;
};

/** Read one inert devalue frame and defer settlement consumption until hydration has attached. */
export function readInitialDocument(
  document: Document = globalThis.document,
  transport: Transport = {},
): DocumentSession {
  const initial = document.getElementById(dataElementId);
  if (!(initial instanceof HTMLScriptElement))
    throw new Error(`Missing #${dataElementId} initial data script`);
  let encoded: unknown;
  try {
    encoded = JSON.parse(initial.textContent ?? "");
  } catch (error) {
    throw new Error("Malformed Velveteen initial data", { cause: error });
  }
  if (typeof encoded !== "string")
    throw new Error("Velveteen initial data must contain one encoded frame");
  let decoder: ReturnType<typeof createDecoder>;
  try {
    decoder = createDecoder(encoded, transport);
    assertPayload(decoder.value);
  } catch (error) {
    throw new Error("Invalid Velveteen initial data", { cause: error });
  }
  let active = false;
  let finished = false;
  let onError: (error: unknown) => void = () => {};
  let observer: MutationObserver | undefined;
  let domReady: (() => void) | undefined;
  const report = (error: unknown) => {
    onError(error);
  };
  const consume = (script: HTMLScriptElement) => {
    if (
      !script.matches("script[data-velveteen-settlement]") ||
      !script.isConnected
    )
      return;
    try {
      decoder.accept(JSON.parse(script.textContent ?? ""));
      script.remove();
    } catch (error) {
      decoder.abort(error);
      script.remove();
      report(error);
    }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    observer?.disconnect();
    if (domReady) document.removeEventListener("DOMContentLoaded", domReady);
    try {
      decoder.finish();
    } catch (error) {
      report(error);
    }
  };
  const scan = () =>
    document
      .querySelectorAll<HTMLScriptElement>("script[data-velveteen-settlement]")
      .forEach(consume);
  const activate = (callback?: (error: unknown) => void) => {
    if (active || finished) return;
    active = true;
    onError = callback ?? (() => {});
    scan();
    observer = new MutationObserver((records) =>
      records.forEach((record) =>
        record.addedNodes.forEach((node) => {
          if (node instanceof HTMLScriptElement) consume(node);
          if (node instanceof Element)
            node
              .querySelectorAll<HTMLScriptElement>(
                "script[data-velveteen-settlement]",
              )
              .forEach(consume);
        }),
      ),
    );
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    if (document.readyState === "loading") {
      domReady = finish;
      document.addEventListener("DOMContentLoaded", domReady, { once: true });
    } else
      queueMicrotask(() => {
        scan();
        finish();
      });
  };
  return {
    payload: decoder.value,
    activate,
    dispose() {
      observer?.disconnect();
      if (domReady) document.removeEventListener("DOMContentLoaded", domReady);
      decoder.abort(
        new DOMException("Document session disposed", "AbortError"),
      );
      finished = true;
    },
  };
}
