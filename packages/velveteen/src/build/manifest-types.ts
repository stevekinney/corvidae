import type {
  ClientRouteManifest,
  RouteManifest,
} from "../routing/manifest-types.ts";

/** All file paths are relative to one immutable production generation. */
export type ProductionOutput = {
  file: string;
  target: "browser" | "server" | "static";
  bytes: number;
  sha256: string;
};

/** Only these exact URLs are exposed by native serving; server/build metadata is never public. */
export type ProductionAsset = ProductionOutput & {
  url: string;
  contentType: string;
  immutable: boolean;
};
export type BrowserModule = {
  file: string;
  url: string;
  stylesheets: string[];
};
export type ServerModule = { file: string };
export type ClientModuleRole =
  "page" | "layout" | "error" | "pageUniversal" | "layoutUniversal";
type ServerModuleRole =
  ClientModuleRole | "pageServer" | "layoutServer" | "endpoint";
export type BrowserNode = Partial<Record<ClientModuleRole, BrowserModule>>;
export type ServerNode = Partial<Record<ServerModuleRole, ServerModule>>;

export type ProductionManifest = {
  version: 1;
  basePath: string;
  routing: ClientRouteManifest;
  client: BrowserModule & { nodes: Record<string, BrowserNode> };
  server: ServerModule & { nodes: Record<string, ServerNode> };
  routes: Record<string, { stylesheets: string[] }>;
  assets: ProductionAsset[];
  outputs: ProductionOutput[];
};

/** Build into a fresh staging directory; publication is a separate, atomic operation. */
export type ProductionGraphOptions = {
  mode?: "development" | "production";
  projectDirectory: string;
  manifest: RouteManifest;
  stagingDirectory: string;
  staticDirectory?: string;
  basePath?: string;
  transportModule?: string;
  browserPlugins?: readonly Bun.BunPlugin[];
};
export type ProductionGraphResult = {
  manifest: ProductionManifest;
  metadata: { browser: Bun.BuildMetafile; server: Bun.BuildMetafile };
};
export type ProductionGeneration = {
  directory: string;
  manifest: ProductionManifest;
};
