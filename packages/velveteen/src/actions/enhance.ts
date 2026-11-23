import type { ActionResult } from "./server.ts";
export type EnhanceOptions = {
  submit: (url: URL, init: RequestInit) => Promise<ActionResult>;
  onError: (error: unknown) => void;
};
/** Native form submission with latest-submission ownership and explicit application commit. */
export function enhance(
  form: HTMLFormElement,
  options: EnhanceOptions,
): () => void {
  // A detached clone reads native properties even when a form control is named "action" or "method".
  const properties = () => form.cloneNode(false) as HTMLFormElement;
  if (properties().method.toLowerCase() !== "post")
    throw new TypeError("Enhanced forms must use POST");
  let disposed = false;
  let controller: AbortController | undefined;
  const submit = async (event: SubmitEvent) => {
    if (event.defaultPrevented || disposed) return;
    const submitter =
      event.submitter instanceof HTMLButtonElement ||
      event.submitter instanceof HTMLInputElement
        ? event.submitter
        : null;
    const native = properties();
    const method = submitter?.hasAttribute("formmethod")
      ? submitter.formMethod
      : native.method;
    if (method.toLowerCase() !== "post") return;
    const destination = new URL(
      submitter?.hasAttribute("formaction")
        ? submitter.formAction
        : native.action,
    );
    if (destination.origin !== location.origin) return;
    event.preventDefault();
    controller?.abort(new DOMException("Superseded submission", "AbortError"));
    controller = new AbortController();
    const signal = controller.signal;
    try {
      const enctype = submitter?.hasAttribute("formenctype")
        ? submitter.formEnctype
        : native.enctype;
      const data = new FormData(form, submitter);
      let body: FormData | URLSearchParams = data;
      if (enctype !== "multipart/form-data") {
        const fields: [string, string][] = [];
        for (const [name, value] of data) {
          if (value instanceof File)
            throw new TypeError("File uploads require multipart/form-data");
          fields.push([name, value]);
        }
        body = new URLSearchParams(fields);
      }
      const headers = new Headers();
      if (enctype === "text/plain") headers.set("content-type", "text/plain");
      const result = await options.submit(destination, {
        method: "POST",
        body,
        headers,
        signal,
      });
      if (disposed || signal.aborted) return;
      if (result.type === "success") HTMLFormElement.prototype.reset.call(form);
    } catch (error) {
      if (!disposed && !signal.aborted) options.onError(error);
    }
  };
  form.addEventListener("submit", submit);
  return () => {
    disposed = true;
    controller?.abort(new DOMException("Form disposed", "AbortError"));
    form.removeEventListener("submit", submit);
  };
}
