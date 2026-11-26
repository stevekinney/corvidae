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

/** Parses the request Cookie header into the values visible to application code. */
export function parseRequestCookies(header: string) {
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    cookies.set(name, decodeCookieValue(part.slice(separator + 1).trim()));
  }
  return cookies;
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
  return {
    name,
    value,
    httpOnly: true,
    secure: secureByDefault,
    sameSite: "lax",
    ...options,
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
      `SameSite=${cookie.sameSite[0]!.toUpperCase()}${cookie.sameSite.slice(1)}`,
    );
  return attributes.join("; ");
}
