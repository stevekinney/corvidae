import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, rename } from "node:fs/promises";
import { join, resolve } from "node:path";

export type ServiceWorkerMetadata = {
  base: string;
  version: string;
  build: string;
  files: string[];
  prerendered: string[];
};
export type ServiceWorkerFile = { url: string; sha256: string };
export type ServiceWorkerOptions = {
  outputDirectory: string;
  base?: string;
  build: string;
  files: ServiceWorkerFile[];
  prerendered: string[];
  install: string;
};

/** Compute a stable cache version from the public URL and content identities. */
export function serviceWorkerVersion(files: ServiceWorkerFile[]): string {
  return createHash("sha256")
    .update(
      [...files]
        .toSorted((a, b) => a.url.localeCompare(b.url))
        .map((file) => `${file.url}\0${file.sha256}\n`)
        .join(""),
    )
    .digest("hex");
}

/** Bundle a synchronous install(metadata) initializer. The application registers native install/activate/fetch events and owns waitUntil/cache policy. */
export async function buildServiceWorker(
  options: ServiceWorkerOptions,
): Promise<{ file: string; metadata: ServiceWorkerMetadata }> {
  const metadata: ServiceWorkerMetadata = {
    base: options.base ?? "",
    version: serviceWorkerVersion(options.files),
    build: options.build,
    files: options.files.map(({ url }) => url).toSorted(),
    prerendered: [...options.prerendered].toSorted(),
  };
  await mkdir(options.outputDirectory, { recursive: true });
  const temporary = await mkdtemp(
    join(resolve(options.outputDirectory), ".sw-"),
  );
  try {
    const source = join(temporary, "bootstrap.ts");
    const install = `import { install } from ${JSON.stringify(resolve(options.install))};\n`;
    await Bun.write(
      source,
      `${install}const metadata=${JSON.stringify(metadata)};\nconst result=install(metadata);if(result!==undefined)throw new TypeError("Worker initializer must register native event handlers synchronously and return undefined");\n`,
    );
    await mkdir(options.outputDirectory, { recursive: true });
    const result = await Bun.build({
      entrypoints: [source],
      outdir: join(temporary, "output"),
      target: "browser",
      splitting: false,
      minify: true,
      naming: "service-worker.js",
    });
    if (!result.success || result.logs.length)
      throw new AggregateError(result.logs, "Service worker build failed");
    await rename(
      join(temporary, "output/service-worker.js"),
      join(options.outputDirectory, "service-worker.js"),
    );
    return {
      file: join(options.outputDirectory, "service-worker.js"),
      metadata,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
