import type {
  MatchableRoute,
  RouteMatchers,
  RouteMatch,
  RouteParameterValue,
} from "./manifest-types.ts";

export function isRouteParameterValue(
  value: unknown,
): value is RouteParameterValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  );
}

export class RouteMatcherError extends Error {
  constructor(
    readonly matcher: string,
    cause: unknown,
    detail?: string,
  ) {
    super(`Parameter matcher ${matcher} failed${detail ? `: ${detail}` : ""}`, {
      cause,
    });
    this.name = "RouteMatcherError";
  }
}

/** Browser-safe matching. Malformed URL escapes throw URIError (the HTTP boundary returns 400). */
export function matchRoute<Route extends MatchableRoute>(
  manifest: { routes: readonly Route[] },
  pathname: string,
  matchers: RouteMatchers = {},
): RouteMatch<Route> | undefined {
  // Kit's decode_pathname convention preserves %25 so a parameter is decoded exactly once.
  const normalized = pathname.split("%25").map(decodeURI).join("%25");
  for (const route of manifest.routes) {
    const match = new RegExp(route.pattern).exec(normalized);
    if (!match) continue;
    const params: Record<string, RouteParameterValue> = Object.create(null);
    const values = match.slice(1);
    const valuesNeedingMatch = values.filter((value) => value !== undefined);
    let buffered = 0;
    let rejected = false;
    for (let index = 0; index < route.params.length; index += 1) {
      const parameter = route.params[index];
      let value = values[index - buffered];

      // A skipped chained optional is reassigned to the next capture, or folded
      // into a following rest capture, exactly as Kit's route executor does.
      if (parameter.chained && parameter.rest && buffered) {
        value = values
          .slice(index - buffered, index + 1)
          .filter((part) => part)
          .join("/");
        buffered = 0;
      }
      if (value === undefined) {
        if (parameter.rest) value = "";
        else continue;
      }

      const decoded = decodeURIComponent(value);
      if (parameter.matcher) {
        const matcher = matchers[parameter.matcher];
        if (
          !Object.hasOwn(matchers, parameter.matcher) ||
          typeof matcher !== "function"
        )
          throw new RouteMatcherError(
            parameter.matcher,
            new Error("Matcher is missing from the runtime registry"),
            "runtime registry is missing this matcher",
          );
        let result: unknown;
        try {
          result = matcher(decoded);
        } catch (error) {
          throw new RouteMatcherError(parameter.matcher, error);
        }
        if (result instanceof Promise) {
          void result.catch(() => undefined);
          throw new RouteMatcherError(
            parameter.matcher,
            undefined,
            "asynchronous output is not supported",
          );
        }
        if (result === undefined) {
          if (parameter.optional && parameter.chained) {
            buffered += 1;
            continue;
          }
          rejected = true;
          break;
        }
        if (!isRouteParameterValue(result)) {
          throw new RouteMatcherError(
            parameter.matcher,
            undefined,
            "output must be a primitive or undefined",
          );
        }
        params[parameter.name] = result;
      } else params[parameter.name] = decoded;

      const nextParameter = route.params[index + 1];
      const nextValue = values[index + 1];
      if (
        nextParameter &&
        !nextParameter.rest &&
        nextParameter.optional &&
        nextValue &&
        parameter.chained
      )
        buffered = 0;

      if (
        !nextParameter &&
        !nextValue &&
        Object.keys(params).length === valuesNeedingMatch.length
      )
        buffered = 0;
    }
    if (rejected || buffered) continue;
    return { route, params, pathname };
  }
  return undefined;
}
