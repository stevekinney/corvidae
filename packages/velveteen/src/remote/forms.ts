import { error } from "../data/errors.ts";
import {
  type ActionData,
  type ActionFailure,
  executeFormAction,
  isActionFailure,
} from "../actions/server.ts";
import type { RequestEvent } from "../server/types.ts";
import { validRemoteName } from "./protocol.ts";

export type RemoteFormDefinition<
  Input,
  Output extends ActionData = ActionData,
> = {
  validate: (
    formData: FormData,
  ) =>
    | Input
    | ActionFailure<ActionData>
    | Promise<Input | ActionFailure<ActionData>>;
  handle: (
    input: Input,
    event: RequestEvent,
  ) =>
    | Output
    | ActionFailure<ActionData>
    | Promise<Output | ActionFailure<ActionData>>;
};
export type RemoteForms = Record<
  string,
  {
    validate: (formData: FormData) => unknown;
    handle: (input: never, event: RequestEvent) => unknown;
  }
>;

export function defineRemoteForm<Input, Output extends ActionData = ActionData>(
  definition: RemoteFormDefinition<Input, Output>,
): RemoteFormDefinition<Input, Output> {
  return definition;
}

/** Build a progressive form action while retaining the page's ordinary query. */
export function remoteFormAction(url: string | URL, name: string): string {
  if (!validRemoteName(name)) throw new TypeError("Invalid remote form name");
  const address = new URL(url, "http://velveteen.invalid");
  if (address.protocol !== "http:" && address.protocol !== "https:")
    throw new TypeError("Invalid remote form URL protocol");
  if (address.pathname.startsWith("//"))
    throw new TypeError("Ambiguous remote form path");
  for (const key of Array.from(address.searchParams.keys()))
    if (key.startsWith("/")) address.searchParams.delete(key);
  const ordinaryQuery = address.searchParams.toString();
  return `${address.pathname}?${ordinaryQuery ? ordinaryQuery + "&" : ""}/remote=${name}${address.hash}`;
}

function selectForm(
  forms: RemoteForms,
  event: RequestEvent,
): RemoteForms[string] {
  const selectors = [...event.url.searchParams.keys()].filter((key) =>
    key.startsWith("/"),
  );
  const remote = selectors.filter((key) => key === "/remote");
  if (remote.length !== 1 || selectors.length !== 1)
    throw error(400, "Invalid remote form selector");
  const name = event.url.searchParams.get("/remote");
  if (!name || !validRemoteName(name) || !Object.hasOwn(forms, name))
    throw error(404, "Not Found");
  return forms[name];
}

/** Execute a registered remote form through the ordinary action result lifecycle. */
export async function runRemoteForm(forms: RemoteForms, event: RequestEvent) {
  const form = selectForm(forms, event);
  return executeFormAction(event, async (data) => {
    const input = await form.validate(data);
    if (isActionFailure(input)) return input;
    return form.handle(input as never, event);
  });
}
