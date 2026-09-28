import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte']);
const ignoredPathSegment =
  /^(?:node_modules|dist|build|coverage|\.turbo|\.svelte-kit|\.playwright|\.bun)$/;

const NUL = 0x00;

/**
 * A source file containing a raw NUL byte is not a text file, and the tools
 * that read source treat it accordingly: `grep` classifies it as binary and
 * silently reports no matches, and `git diff` prints "Binary files differ"
 * instead of a diff. Both fail quietly, so a search over such a file returns
 * a confidently wrong answer rather than an error.
 *
 * Nothing else in this repository catches it. A NUL is a valid character in a
 * string literal, so lint, `tsc`, and the full test suite all pass over a file
 * that has become unreadable to every code-search tool. That combination —
 * invisible to every gate, and silently corrupting of search — is why this is
 * checked rather than left to review.
 *
 * Use a unicode escape (backslash-u followed by four zeros) when a NUL is
 * genuinely wanted, which is the usual case here: it is a common composite-key
 * delimiter, chosen because it cannot appear in the components being joined.
 * The escape emits the identical byte at runtime, so a persisted key format is
 * unchanged.
 *
 * This comment deliberately spells that escape out in words rather than
 * writing it. Several tools that generate or rewrite files interpret the
 * escape and emit the byte itself — which is how this very file first tripped
 * the check it defines.
 */
async function sourceFiles(): Promise<string[]> {
  const entries = await Array.fromAsync(
    new Bun.Glob('{applications,components,packages,internal,scripts}/**/*').scan({
      cwd: root,
      absolute: true,
      onlyFiles: true,
    }),
  );
  return entries.filter(
    (file) =>
      sourceExtensions.has(file.slice(file.lastIndexOf('.'))) &&
      !file.split('/').some((segment) => ignoredPathSegment.test(segment)),
  );
}

function nulOffsets(bytes: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === NUL) offsets.push(index);
  }
  return offsets;
}

describe('source text encoding', () => {
  test('reports exact byte offsets including consecutive and boundary NULs', () => {
    expect(nulOffsets(new Uint8Array([0, 0, 65, 195, 169, 0]))).toEqual([0, 1, 5]);
    expect(nulOffsets(new TextEncoder().encode('\\u0000'))).toEqual([]);
    expect(nulOffsets(new Uint8Array())).toEqual([]);
  });

  test('no source file contains a raw NUL byte', async () => {
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      // This is a serial local-file audit; avoid one asynchronous I/O queue round trip per file.
      const bytes = readFileSync(file);
      const offsets = nulOffsets(bytes);
      if (offsets.length > 0) {
        offenders.push(
          `${file.slice(root.length + 1)} (${offsets.length} at ${offsets.join(', ')})`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });
});
