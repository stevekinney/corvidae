import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** What a Bun `onLoad` handler returns for a compiled Svelte component. */
export type CompiledSvelteModule = { contents: string; loader: 'js'; resolveDir: string };

/** Everything the compiled output of one component depends on, besides the compiler itself. */
export type SvelteCompileKey = {
  /** Absolute path of the `.svelte` file; its compiled CSS hash and diagnostics carry it. */
  path: string;
  source: string;
  /** The compile options that change the output, spelled out (for example `server:css:prod`). */
  variant: string;
};

export type SvelteCompileCache = {
  /**
   * Return the stored output for `key`, or run `compile`, store what it returns, and return that.
   * A compile that throws is not stored. A cache that cannot read or write never fails the build.
   */
  compile(
    key: SvelteCompileKey,
    compile: () => CompiledSvelteModule,
  ): Promise<CompiledSvelteModule>;
};

function sha256(...parts: readonly string[]): string {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const part of parts) {
    hasher.update(part);
    hasher.update('\0');
  }
  return hasher.digest('hex');
}

/**
 * A compiled-output cache on disk, shared by every process that points at the same directory.
 *
 * Compiling a Svelte component is a pure function of its source, its path, the compile options,
 * and the compiler, but the playground compiles about 2,000 of them (most of them `@lucide/svelte`
 * icons reachable through a few Cinder imports) in every fresh process it spawns to server-render a
 * page, which is where the cost of a cold render goes. Persisting the output across that process
 * boundary takes a render's compile from seconds to a few hundred milliseconds.
 *
 * One file per component and variant, named by hash of the path and variant, whose first line is a
 * fingerprint of everything the output depends on (the compiler fingerprint, the path, the variant,
 * and the source). An entry whose fingerprint does not match is a miss and is overwritten, so the
 * directory holds one entry per component and variant however often a file is edited. Entries are
 * written to a temporary file and renamed into place, so a reader never sees half of one.
 */
export function createSvelteCompileCache(options: {
  directory: string;
  /** Changes whenever anything that is not in the key changes the output (compiler, plugin code). */
  compilerFingerprint: string;
  /** Called at most once, when the directory turns out to be unusable. */
  warn?: (message: string) => void;
}): SvelteCompileCache {
  const { directory, compilerFingerprint } = options;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let storingDisabled = false;

  async function read(
    entryPath: string,
    header: string,
    path: string,
  ): Promise<CompiledSvelteModule | null> {
    let text: string;
    try {
      text = await Bun.file(entryPath).text();
    } catch {
      // No entry yet, or one that cannot be read: either way the output is compiled again.
      return null;
    }
    if (!text.startsWith(header)) return null;
    return { contents: text.slice(header.length), loader: 'js', resolveDir: dirname(path) };
  }

  async function store(
    entryPath: string,
    header: string,
    path: string,
    compiled: CompiledSvelteModule,
  ): Promise<void> {
    // A hit reconstructs everything but the contents, so only output that round-trips is stored.
    if (storingDisabled || compiled.loader !== 'js' || compiled.resolveDir !== dirname(path))
      return;
    const temporaryPath = `${entryPath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(directory, { recursive: true });
      await Bun.write(temporaryPath, `${header}${compiled.contents}`);
      renameSync(temporaryPath, entryPath);
    } catch (error) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // The leftover temporary file is a side effect of the failure reported below, not a second one.
      }
      storingDisabled = true;
      warn(
        `[playground] Svelte compile cache disabled; components compile on every build: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    async compile(key, compile) {
      const entryPath = join(directory, `${sha256(key.path, key.variant).slice(0, 32)}.js`);
      const header = `${sha256(compilerFingerprint, key.path, key.variant, key.source)}\n`;

      const cached = await read(entryPath, header, key.path);
      if (cached !== null) return cached;

      const compiled = compile();
      await store(entryPath, header, key.path, compiled);
      return compiled;
    },
  };
}

/** A fingerprint of the inputs that change compiled output without being in a {@link SvelteCompileKey}. */
export function fingerprintCompiler(...parts: readonly string[]): string {
  return sha256(...parts);
}
