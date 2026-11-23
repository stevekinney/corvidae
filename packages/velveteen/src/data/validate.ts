import type { PagePayload, RuntimeRegistry } from "./contract.ts";
import { isRouteParameterValue } from "../routing/match.ts";
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
/** Reject malformed protocol envelopes before using module indices, URLs or render roles. */
export function assertPayload(value: unknown): asserts value is PagePayload {
  if (
    !record(value) ||
    value.version !== 1 ||
    (value.prerendered !== undefined && value.prerendered !== true) ||
    typeof value.url !== "string" ||
    typeof value.basePath !== "string" ||
    !strings(value.stylesheets) ||
    !(value.routeId === null || typeof value.routeId === "string") ||
    (value.form !== undefined && value.form !== null && !record(value.form)) ||
    !record(value.params) ||
    !Object.values(value.params).every(isRouteParameterValue) ||
    !Number.isInteger(value.status) ||
    Number(value.status) < 100 ||
    Number(value.status) > 599 ||
    !record(value.options) ||
    typeof value.options.ssr !== "boolean" ||
    typeof value.options.csr !== "boolean" ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.branch) ||
    !Array.isArray(value.fetched)
  )
    throw new Error("Invalid page payload");
  const url = new URL(value.url);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Invalid page URL");
  if (
    value.basePath !== "" &&
    !/^\/(?:[A-Za-z0-9_~.-]+)(?:\/[A-Za-z0-9_~.-]+)*$/.test(value.basePath)
  )
    throw new Error("Invalid base path");
  if (value.basePath.split("/").some((part) => part === "." || part === ".."))
    throw new Error("Invalid base path");
  if (
    value.redirect !== undefined &&
    (typeof value.redirect !== "string" ||
      !["http:", "https:"].includes(new URL(value.redirect, url).protocol))
  )
    throw new Error("Invalid redirect URL");
  if (
    value.error !== null &&
    (!record(value.error) || typeof value.error.message !== "string")
  )
    throw new Error("Invalid public error");
  const keys = new Set<string>();
  for (const node of value.nodes) {
    if (
      !record(node) ||
      typeof node.node !== "number" ||
      !Number.isSafeInteger(node.node) ||
      node.node < 0 ||
      (node.role !== "page" && node.role !== "layout") ||
      node.key !== `${String(node.node)}:${node.role}` ||
      !record(node.data) ||
      !record(node.uses) ||
      !strings(node.uses.params) ||
      !strings(node.uses.search) ||
      !strings(node.uses.url) ||
      !strings(node.uses.dependencies) ||
      typeof node.uses.parent !== "boolean" ||
      typeof node.uses.route !== "boolean" ||
      (node.skip !== undefined && typeof node.skip !== "boolean") ||
      keys.has(node.key)
    )
      throw new Error("Invalid load node");
    keys.add(node.key);
  }
  for (const node of value.branch)
    if (
      !record(node) ||
      !(
        node.node === null ||
        (typeof node.node === "number" &&
          Number.isSafeInteger(node.node) &&
          node.node >= 0)
      ) ||
      (node.role !== "page" &&
        node.role !== "layout" &&
        node.role !== "error") ||
      (node.node === null && node.role !== "error") ||
      (node.role !== "error" && !keys.has(`${String(node.node)}:${node.role}`))
    )
      throw new Error("Invalid render branch");
  for (const entry of value.fetched)
    if (
      !record(entry) ||
      typeof entry.key !== "string" ||
      typeof entry.status !== "number" ||
      typeof entry.statusText !== "string" ||
      !Array.isArray(entry.headers) ||
      !entry.headers.every(
        (header) => strings(header) && header.length === 2,
      ) ||
      !(entry.body instanceof Uint8Array)
    )
      throw new Error("Invalid captured fetch");
}

/** A valid wire shape must also refer to roles present in this immutable application registry. */
export function assertRegistryPayload(
  payload: PagePayload,
  registry: RuntimeRegistry,
) {
  assertPayload(payload);
  const route = registry.manifest.routes.find(
    (candidate) => candidate.id === payload.routeId,
  );
  const layouts = new Set(route?.layouts ?? []);
  const errors = new Set(route?.errors ?? []);
  for (const node of payload.nodes) {
    if (
      !registry.nodes[node.node] ||
      !(node.role === "page"
        ? node.node === route?.leaf
        : layouts.has(node.node))
    )
      throw new Error("Unknown load node");
  }
  let layoutPosition = -1;
  for (const [position, node] of payload.branch.entries()) {
    if (
      node.node !== null &&
      (!(node.role === "page"
        ? node.node === route?.leaf
        : node.role === "error"
          ? errors.has(node.node)
          : layouts.has(node.node)) ||
        typeof registry.nodes[node.node]?.[node.role] !== "function")
    )
      throw new Error("Unknown render role");
    if (node.role === "layout") {
      const index = route?.layouts.indexOf(node.node) ?? -1;
      if (index <= layoutPosition)
        throw new Error("Invalid render branch order");
      layoutPosition = index;
    } else if (position !== payload.branch.length - 1) {
      throw new Error("Invalid render branch order");
    }
  }
}
