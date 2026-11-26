import type { Fetch } from "../data/contract.ts";
import { loadRequest } from "../data/fetch.ts";
import type { ApplicationOptions, RequestEvent } from "./types.ts";
import {
  createCookie,
  parseRequestCookies,
  parseSetCookie,
  serializeCookie,
  type ServerCookie,
} from "./cookies.ts";

export function createEvent(
  request: Request,
  url: URL,
  signal: AbortSignal,
  dispatch: Fetch,
  options: ApplicationOptions,
) {
  const jar = parseRequestCookies(request.headers.get("cookie") ?? "");
  type CookieScope = {
    cookie: ServerCookie;
    path: string;
    secure: boolean;
    domain?: string;
    expires?: Date;
    expiresAt?: number;
  };
  const cookieScopes = new Map<string, CookieScope>();
  const headers = new Headers();
  const domainMatches = (domain: string | undefined, hostname: string) => {
    if (!domain) return true;
    const normalized = domain.toLowerCase().replace(/^\./, "");
    const host = hostname.toLowerCase();
    return host === normalized || host.endsWith(`.${normalized}`);
  };
  const pathMatches = (path: string, pathname: string) =>
    pathname === path ||
    pathname.startsWith(path.endsWith("/") ? path : `${path}/`);
  const scopeKey = (name: string, path: string, domain?: string) =>
    JSON.stringify([name, domain?.toLowerCase().replace(/^\./, ""), path]);
  const storeCookie = (
    cookie: ServerCookie,
    source: URL,
    defaultPath: string,
  ) => {
    if (!domainMatches(cookie.domain, source.hostname)) return;
    const path = cookie.path ?? defaultPath;
    const key = scopeKey(cookie.name, path, cookie.domain);
    cookieScopes.set(key, {
      cookie,
      path,
      secure: cookie.secure ?? false,
      domain: cookie.domain,
      expires: cookie.expires,
      expiresAt:
        cookie.maxAge === undefined
          ? undefined
          : Date.now() + cookie.maxAge * 1000,
    });
    jar.set(cookie.name, cookie.value);
  };
  const event: RequestEvent = {
    request,
    url,
    signal,
    params: {},
    route: { id: null },
    locals: {},
    platform: options.platform,
    cookies: {
      get: (name) => jar.get(name) ?? undefined,
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      set: (name, value, attributes) => {
        const cookie = createCookie(
          name,
          value,
          attributes,
          url.protocol === "https:",
        );
        storeCookie(cookie, url, attributes.path);
      },
      delete: (name, attributes) => {
        const cookie = createCookie(
          name,
          "",
          { ...attributes, maxAge: 0 },
          url.protocol === "https:",
        );
        storeCookie(cookie, url, attributes.path);
      },
    },
    fetch: async (input, init) => {
      const initial = loadRequest(input, init, url.href, signal);
      const ambient = new Set<string>();
      const makeRequest = (candidate: Request, previous?: Request) => {
        const target = new URL(candidate.url);
        if (previous) {
          for (const name of ambient) candidate.headers.delete(name);
          if (target.origin !== new URL(previous.url).origin)
            for (const name of [
              "cookie",
              "authorization",
              "proxy-authorization",
            ])
              candidate.headers.delete(name);
        }
        if (target.origin === url.origin && !candidate.headers.has("origin"))
          candidate.headers.set("origin", url.origin);
        if (target.origin === url.origin && candidate.credentials !== "omit") {
          if (!candidate.headers.has("cookie")) {
            const scopedNames = new Set(
              [...cookieScopes.values()].map(({ cookie }) => cookie.name),
            );
            const ambientCookies = [...jar]
              .filter(([name]) => !scopedNames.has(name))
              .map(([name, cookie]) => `${name}=${cookie}`);
            const scoped = [...cookieScopes.values()]
              .filter((scope) => {
                const { cookie } = scope;
                if (!pathMatches(scope.path, target.pathname)) return false;
                if (scope.secure && target.protocol !== "https:") return false;
                if (!domainMatches(scope.domain, target.hostname)) return false;
                if (
                  scope.expiresAt !== undefined &&
                  scope.expiresAt <= Date.now()
                )
                  return false;
                if (scope.expires && scope.expires.getTime() <= Date.now())
                  return false;
                if (cookie.maxAge !== undefined && cookie.maxAge <= 0)
                  return false;
                return true;
              })
              .toSorted((left, right) => right.path.length - left.path.length)
              .map(({ cookie }) => `${cookie.name}=${cookie.value}`);
            const value = [...scoped, ...ambientCookies].join("; ");
            if (value) {
              candidate.headers.set("cookie", value);
              ambient.add("cookie");
            }
          }
          if (
            !candidate.headers.has("authorization") &&
            request.headers.has("authorization")
          ) {
            candidate.headers.set(
              "authorization",
              request.headers.get("authorization")!,
            );
            ambient.add("authorization");
          }
        }
        return candidate;
      };
      const acceptCookies = (
        response: Response,
        responseURL: string,
        credentials: RequestCredentials,
      ) => {
        if (
          credentials === "omit" ||
          new URL(responseURL).origin !== url.origin
        )
          return;
        for (const header of response.headers.getSetCookie()) {
          const cookie = parseSetCookie(header);
          if (!cookie) continue;
          const responseURLObject = new URL(responseURL);
          const responsePath = responseURLObject.pathname;
          const defaultPath = responsePath.includes("/")
            ? responsePath.slice(0, responsePath.lastIndexOf("/")) || "/"
            : "/";
          if (!/(?:^|;)\s*path\s*=/i.test(header)) cookie.path = defaultPath;
          storeCookie(cookie, responseURLObject, defaultPath);
        }
      };
      const network: Fetch = async (networkInput, networkOptions) => {
        let target = makeRequest(
          loadRequest(networkInput, networkOptions, url.href, signal),
        );
        for (let redirects = 0; ; redirects++) {
          target.signal.throwIfAborted();
          const hasBody = target.method !== "GET" && target.method !== "HEAD";
          const preservedBody = hasBody ? target.clone() : undefined;
          const dispatchRequest = target;
          const response =
            new URL(target.url).origin === url.origin
              ? await dispatch(dispatchRequest)
              : await globalThis.fetch(dispatchRequest, { redirect: "manual" });
          acceptCookies(response, target.url, target.credentials);
          if (![301, 302, 303, 307, 308].includes(response.status)) {
            void preservedBody?.body?.cancel().catch(() => {});
            return response;
          }
          const location = response.headers.get("location");
          if (!location || target.redirect === "manual") {
            void preservedBody?.body?.cancel().catch(() => {});
            return response;
          }
          if (target.redirect === "error" || redirects >= 20) {
            void preservedBody?.body?.cancel().catch(() => {});
            await response.body?.cancel();
            throw new TypeError(
              target.redirect === "error"
                ? "Redirect encountered"
                : "Maximum redirect count exceeded",
            );
          }
          const nextUrl = new URL(location, target.url);
          const method =
            (response.status === 303 &&
              !["GET", "HEAD"].includes(target.method)) ||
            ((response.status === 301 || response.status === 302) &&
              target.method === "POST")
              ? "GET"
              : target.method;
          const body =
            method === "GET" || method === "HEAD"
              ? undefined
              : await preservedBody?.arrayBuffer();
          if (!body) void preservedBody?.body?.cancel().catch(() => {});
          await response.body?.cancel();
          const redirectedHeaders = new Headers(target.headers);
          if (method !== target.method)
            for (const name of [
              "content-type",
              "content-length",
              "content-encoding",
              "content-language",
              "content-location",
            ])
              redirectedHeaders.delete(name);
          if (!["http:", "https:"].includes(nextUrl.protocol))
            throw new TypeError("Invalid fetch redirect protocol");
          target = makeRequest(
            loadRequest(
              nextUrl,
              {
                method,
                headers: redirectedHeaders,
                body,
                credentials: target.credentials,
                redirect: target.redirect,
                signal: target.signal,
              },
              url.href,
              signal,
            ),
            target,
          );
        }
      };
      const response = await (options.hooks?.handleFetch?.({
        event,
        request: makeRequest(initial),
        fetch: network,
      }) ?? network(makeRequest(initial)));
      return response;
    },
    setHeaders(values) {
      for (const [name, value] of Object.entries(values)) {
        if (name.toLowerCase() === "set-cookie")
          throw new Error("Use cookies.set for Set-Cookie");
        if (headers.has(name))
          throw new Error(`Duplicate response header: ${name}`);
        headers.set(name, value);
      }
    },
    getClientAddress() {
      if (!options.getClientAddress)
        throw new Error("Client address is unavailable");
      return options.getClientAddress(request);
    },
  };
  return {
    event,
    apply(response: Response) {
      const combined = new Headers(response.headers);
      for (const [name, value] of headers) combined.set(name, value);
      for (const { cookie } of cookieScopes.values())
        combined.append("set-cookie", serializeCookie(cookie));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: combined,
      });
    },
  };
}
