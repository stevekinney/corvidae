import type { CookieOptions } from "./types.ts";

export type ServerCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: Date;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none";
  partitioned?: boolean;
};

function decodeCookieValue(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sameSite(value: string): ServerCookie["sameSite"] {
  switch (value.toLowerCase()) {
    case "strict":
    case "lax":
    case "none":
      return value.toLowerCase() as ServerCookie["sameSite"];
    default:
      return undefined;
  }
}

type RequestCookie = { name: string; value: string };

const invalidCookieName = /[\u0000-\u001f\u007f()<>@,;:\\"/\[\]?={}\s]/;
const invalidCookiePath = /[\u0000-\u001f\u007f;]/;
const invalidCookieDomain = /[\u0000-\u001f\u007f\s;\\/]/;

function validateCookieOptions(name: string, options: CookieOptions) {
  if (!name || invalidCookieName.test(name))
    throw new TypeError("Cookie names cannot contain invalid characters");
  if (options.path && invalidCookiePath.test(options.path))
    throw new TypeError("Cookie paths cannot contain invalid characters");
  if (options.domain && invalidCookieDomain.test(options.domain))
    throw new TypeError("Cookie domains cannot contain invalid characters");
}

/** Request cookies preserve duplicate names and their header order from the native runtime. */
export class RequestCookies implements Iterable<[string, string]> {
  #cookies: RequestCookie[];

  constructor(cookies: RequestCookie[]) {
    this.#cookies = cookies;
  }

  get(name: string) {
    return this.#cookies.find((cookie) => cookie.name === name)?.value;
  }

  set(name: string, value: string) {
    const first = this.#cookies.findIndex((cookie) => cookie.name === name);
    this.#cookies = this.#cookies.filter((cookie) => cookie.name !== name);
    this.#cookies.splice(first < 0 ? this.#cookies.length : first, 0, {
      name,
      value,
    });
  }

  *[Symbol.iterator](): Iterator<[string, string]> {
    for (const cookie of this.#cookies) yield [cookie.name, cookie.value];
  }
}

/** Parses the request Cookie header into the values visible to application code. */
export function parseRequestCookies(header: string) {
  const cookies: RequestCookie[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    cookies.push({
      name,
      value: decodeCookieValue(part.slice(separator + 1).trim()),
    });
  }
  return new RequestCookies(cookies);
}

/** Parses one Set-Cookie header without requiring a runtime-specific cookie implementation. */
export function parseSetCookie(header: string): ServerCookie | undefined {
  const [pair, ...attributes] = header.split(";");
  if (!pair) return undefined;
  const separator = pair.indexOf("=");
  if (separator < 1) return undefined;
  const name = pair.slice(0, separator).trim();
  if (!name) return undefined;
  const cookie: ServerCookie = {
    name,
    value: pair.slice(separator + 1).trim(),
    sameSite: "lax",
  };

  for (const attribute of attributes) {
    const [rawName, ...rawValue] = attribute.trim().split("=");
    const attributeName = rawName?.trim().toLowerCase();
    const value = rawValue.join("=").trim();
    switch (attributeName) {
      case "domain":
        if (value) cookie.domain = value;
        break;
      case "path":
        if (value) cookie.path = value;
        break;
      case "expires": {
        const expires = new Date(value);
        if (!Number.isNaN(expires.getTime())) cookie.expires = expires;
        break;
      }
      case "max-age": {
        const maxAge = Number.parseInt(value, 10);
        if (Number.isFinite(maxAge)) cookie.maxAge = maxAge;
        break;
      }
      case "secure":
        cookie.secure = true;
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      case "partitioned":
        cookie.partitioned = true;
        break;
      case "samesite": {
        const parsed = sameSite(value);
        if (parsed) cookie.sameSite = parsed;
        break;
      }
    }
  }
  return cookie;
}

/** Creates a cookie from an application mutation with the server's required defaults. */
export function createCookie(
  name: string,
  value: string,
  options: CookieOptions,
  secureByDefault: boolean,
): ServerCookie {
  if (typeof options.path !== "string")
    throw new TypeError("Cookies require an explicit path");
  validateCookieOptions(name, options);
  return {
    name,
    value,
    httpOnly: true,
    secure: secureByDefault,
    sameSite: "lax",
    ...options,
    expires: options.expires && new Date(options.expires),
  };
}

/** Serializes a cookie in the order Bun used for Velveteen's existing response contract. */
export function serializeCookie(cookie: ServerCookie) {
  const attributes = [`${cookie.name}=${encodeURIComponent(cookie.value)}`];
  if (cookie.domain) attributes.push(`Domain=${cookie.domain}`);
  if (cookie.path) attributes.push(`Path=${cookie.path}`);
  if (cookie.expires)
    attributes.push(`Expires=${cookie.expires.toUTCString()}`);
  if (cookie.maxAge !== undefined) attributes.push(`Max-Age=${cookie.maxAge}`);
  if (cookie.secure) attributes.push("Secure");
  if (cookie.httpOnly) attributes.push("HttpOnly");
  if (cookie.partitioned) attributes.push("Partitioned");
  if (cookie.sameSite)
    attributes.push(
      `SameSite=${cookie.sameSite[0].toUpperCase()}${cookie.sameSite.slice(1)}`,
    );
  return attributes.join("; ");
}
