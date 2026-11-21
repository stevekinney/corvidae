import { resolve } from "node:path";
import type {
  RouteNode,
  ClientRouteManifest,
} from "../routing/manifest-types.ts";

export type Target = "browser" | "server";
export type Role =
  | "page"
  | "layout"
  | "error"
  | "pageUniversal"
  | "layoutUniversal"
  | "pageServer"
  | "layoutServer"
  | "endpoint";
export const clientRoles: Role[] = [
  "page",
  "layout",
  "error",
  "pageUniversal",
  "layoutUniversal",
];
export const serverRoles: Role[] = [
  ...clientRoles,
  "pageServer",
  "layoutServer",
  "endpoint",
];
const sourcePath = (root: string, file: string) => resolve(root, file);
export const roleSource = (node: RouteNode, role: Role): string | undefined =>
  role === "error"
    ? node.error
    : role === "page"
      ? node.page?.component
      : role === "layout"
        ? node.layout?.component
        : role === "pageUniversal"
          ? node.page?.universal
          : role === "layoutUniversal"
            ? node.layout?.universal
            : role === "pageServer"
              ? node.page?.server
              : role === "layoutServer"
                ? node.layout?.server
                : node.endpoint;
export const wrapper = (node: RouteNode, role: Role, root: string) => {
  const file = roleSource(node, role);
  if (!file) throw new Error(`Missing ${role} source for ${node.id}`);
  const source = sourcePath(root, file);
  return role.endsWith("Universal") ||
    role.endsWith("Server") ||
    role === "endpoint"
    ? `export * from ${JSON.stringify(source)};\n`
    : `export { default } from ${JSON.stringify(source)};\n`;
};
export const registry = (
  entries: Array<Partial<Record<Role, string>>>,
  target: Target,
  manifest: ClientRouteManifest,
  matcherModule?: string,
  transportModule?: string,
) => {
  const nodes = entries.map(
    (roles) =>
      `{${Object.entries(roles)
        .map(
          ([role, file]) =>
            `${role}:()=>import(${JSON.stringify(`./${file}`)})`,
        )
        .join(",")}}`,
  );
  const runtime =
    target === "browser"
      ? 'export { mount, hydrate, unmount } from "svelte";'
      : 'export { render } from "svelte/server";';
  const root = JSON.stringify(
    resolve(import.meta.dir, "../client/root.svelte"),
  );
  const client =
    target === "browser"
      ? `import {startClient} from ${JSON.stringify(resolve(import.meta.dir, "../client/index.ts"))}; export const start = (options) => startClient({nodes,manifest,Root,matchers,transport},options);`
      : "";
  const matchers = matcherModule
    ? `export {matchers}; import {params as matchers} from ${JSON.stringify(matcherModule)};`
    : "export const matchers = undefined;";
  const transport = transportModule
    ? `import {transport} from ${JSON.stringify(transportModule)}; export {transport};`
    : "export const transport = undefined;";
  return `import Root from ${root};export {Root};${client}\n${runtime}\n${matchers}\n${transport}\nexport const manifest=${JSON.stringify(manifest)};\nexport const nodes=[${nodes.join(",")}];\n`;
};
