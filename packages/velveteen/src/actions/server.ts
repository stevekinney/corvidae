import { error } from "../data/errors.ts";
import type { RequestEvent } from "../server/types.ts";

const failureBrand = Symbol.for("velveteen.action.failure");
export type ActionData = Record<string, unknown> | undefined;
type Action = (
  event: RequestEvent,
) =>
  | ActionData
  | BrandedFailure<ActionData>
  | Promise<ActionData | BrandedFailure<ActionData>>;
export type ActionFailure<Data extends ActionData = ActionData> = {
  type: "failure";
  status: number;
  data: Data;
  [failureBrand]: true;
};
type ActionSuccess = {
  type: "success";
  status: number;
  data: ActionData;
};
export type ActionResult =
  Omit<ActionFailure, typeof failureBrand> | ActionSuccess;
type BrandedFailure<Data extends ActionData> = ActionFailure<Data> & {
  [failureBrand]: true;
};

/** Return a branded validation failure for an action without throwing. */
export function fail<Data extends ActionData>(
  status: number,
  data: Data,
): BrandedFailure<Data> {
  if (!Number.isInteger(status) || status < 400 || status > 599)
    throw new RangeError("Action failure status must be 400–599");
  return Object.assign(
    { type: "failure" as const, status, data },
    { [failureBrand]: true as const },
  );
}

export function isActionFailure(value: unknown): value is ActionFailure {
  return (
    !!value &&
    typeof value === "object" &&
    failureBrand in value &&
    value[failureBrand] === true
  );
}

function selectAction(actions: unknown, event: RequestEvent): Action {
  if (!actions || typeof actions !== "object" || Array.isArray(actions))
    throw error(500, "Invalid actions export");
  const names = Object.keys(actions);
  if (names.includes("default") && names.some((name) => name !== "default"))
    throw error(500, "Actions cannot export both default and named actions");
  const named = [...event.url.searchParams.keys()].find((key) =>
    key.startsWith("/"),
  );
  const name = named ? named.slice(1) : "default";
  const selected = (actions as Record<string, unknown>)[name];
  if (
    !Object.prototype.hasOwnProperty.call(actions, name) ||
    typeof selected !== "function"
  )
    throw error(404, "Not Found");
  return selected as Action;
}

/** Execute a default or named POST action against a native form request. */
export async function runAction(
  actions: unknown,
  event: RequestEvent,
): Promise<ActionResult> {
  return executeFormAction(event, () => selectAction(actions, event)(event));
}

/** Validate the native form request and normalize a selected action's result. */
export async function executeFormAction(
  event: RequestEvent,
  action: (form: FormData) => unknown,
): Promise<ActionResult> {
  if (event.request.method !== "POST") throw error(405, "Method Not Allowed");
  const contentType = event.request.headers.get("content-type") ?? "";
  if (
    !/^multipart\/form-data\b|^application\/x-www-form-urlencoded\b/i.test(
      contentType,
    )
  )
    throw error(415, "Unsupported Media Type");
  let form: FormData;
  try {
    form = await event.request.clone().formData();
  } catch {
    throw error(400, "Bad Request");
  }
  const value = await action(form);
  if (isActionFailure(value)) {
    if (
      !Number.isInteger(value.status) ||
      value.status < 400 ||
      value.status > 599
    )
      throw new TypeError("Invalid action failure");
    assertData(value.data);
    return { type: "failure", status: value.status, data: value.data };
  }
  assertData(value);
  return { type: "success", status: 200, data: value };
}

function assertData(value: unknown): asserts value is ActionData {
  if (
    value !== undefined &&
    (!value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null))
  )
    throw new TypeError("Actions must return a plain data object or undefined");
}
