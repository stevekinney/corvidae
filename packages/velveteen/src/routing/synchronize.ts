import { watch } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { generateRouteTypes } from "../types/index.ts";
import { buildRouteManifest, createClientManifest } from "./index.ts";
import type { ClientRouteManifest, RouteManifest } from "./manifest-types.ts";

export type RoutePublication = {
  manifest: RouteManifest;
  client: ClientRouteManifest;
};

/** Rescan file changes serially, regenerate types, then synchronously publish one manifest. */
export async function synchronizeRoutes(options: {
  routesDirectory: string;
  typesDirectory: string;
  publish: (publication: RoutePublication) => void;
  onError: (error: unknown) => void;
}) {
  const routesDirectory = resolve(options.routesDirectory);
  const typesDirectory = resolve(options.typesDirectory);
  const nested = relative(routesDirectory, typesDirectory);
  if (
    !nested ||
    (!isAbsolute(nested) && nested !== ".." && !nested.startsWith("../"))
  ) {
    throw new Error(
      "Generated types must be outside the watched routes directory",
    );
  }

  let current: RoutePublication | undefined;
  let closed = false;
  let pending = Promise.resolve();
  const scan = async () => {
    try {
      return await buildRouteManifest(routesDirectory);
    } catch (cause) {
      // A recursive scan can observe a child directory just before a rename or removal.
      if (
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "ENOENT" &&
        "path" in cause &&
        typeof cause.path === "string"
      ) {
        const missing = relative(
          routesDirectory,
          resolve(routesDirectory, cause.path),
        );
        if (
          missing &&
          !isAbsolute(missing) &&
          missing !== ".." &&
          !missing.startsWith("../")
        )
          return buildRouteManifest(routesDirectory);
      }
      throw cause;
    }
  };
  const update = async () => {
    if (closed) return;
    // Discovery validates the whole candidate before any declarations or consumer changes.
    const manifest = await scan();
    const client = createClientManifest(manifest);
    await generateRouteTypes(manifest, { outputDirectory: typesDirectory });
    if (closed) return;
    const publication = { manifest, client };
    options.publish(publication);
    current = publication;
  };
  const schedule = () => {
    pending = pending.then(update).catch(options.onError);
  };
  // Subscribe before the initial scan so changes during discovery cannot be lost.
  const watcher = watch(routesDirectory, { recursive: true }, schedule);
  watcher.on("error", options.onError);
  pending = update();
  try {
    await pending;
  } catch (error) {
    closed = true;
    watcher.close();
    throw error;
  }

  return {
    get current() {
      return current!;
    },
    async close() {
      closed = true;
      watcher.close();
      await pending;
    },
  };
}
