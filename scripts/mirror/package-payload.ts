import { Parser, type ReadEntry } from 'tar';

export const packagePayloadAlgorithm = 'sha256-package-payload-v1' as const;

export interface PackagePayloadFile {
  path: string;
  executable: boolean;
}

export interface PackagePayloadContract {
  algorithm: typeof packagePayloadAlgorithm;
  files: PackagePayloadFile[];
  digest: string;
}

interface FileRecord extends PackagePayloadFile {
  bytes: number;
  digest: string;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validatePath(entry: ReadEntry): string {
  const rawPath = entry.path;
  if (
    !rawPath ||
    entry.header.path?.includes('\\') ||
    rawPath.includes('\\') ||
    rawPath.startsWith('/') ||
    rawPath.startsWith('..')
  ) {
    throw new Error(`unsafe package payload path: ${rawPath || '<empty>'}`);
  }
  const trailingSlash = rawPath.endsWith('/');
  if (trailingSlash && entry.type !== 'Directory')
    throw new Error(`regular package payload file has a trailing slash: ${rawPath}`);
  const path = trailingSlash ? rawPath.slice(0, -1) : rawPath;
  const segments = path.split('/');
  const packageRoot = path === 'package' || path === 'package/';
  if (
    (!packageRoot && segments[0] !== 'package') ||
    segments.includes('.') ||
    segments.includes('..') ||
    segments.includes('')
  ) {
    throw new Error(`package payload path is outside package/: ${rawPath}`);
  }
  if (packageRoot && entry.type !== 'Directory')
    throw new Error(`package root must be a directory: ${rawPath}`);
  return path;
}

function isRegularFile(entry: ReadEntry): boolean {
  return entry.type === 'File' || entry.type === 'OldFile';
}

function digestRecords(records: readonly FileRecord[]): string {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const record of records.toSorted((left, right) => comparePaths(left.path, right.path))) {
    hasher.update(
      `${record.path}\0${record.executable ? 1 : 0}\0${record.bytes}\0${record.digest}\0`,
    );
  }
  return hasher.digest('hex');
}

/** Parse and hash a registry package tarball without extracting any untrusted bytes. */
export async function readPackagePayload(archive: Uint8Array): Promise<PackagePayloadContract> {
  const seen = new Set<string>();
  const records: FileRecord[] = [];
  let failure: Error | undefined;
  const parser = new Parser({
    strict: true,
    onReadEntry(entry) {
      let path: string;
      try {
        path = validatePath(entry);
        if (seen.has(path)) throw new Error(`duplicate package payload path: ${path}`);
        seen.add(path);
        if (!isRegularFile(entry) && entry.type !== 'Directory') {
          throw new Error(`unsupported package payload entry type ${entry.type}: ${path}`);
        }
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
        entry.resume();
        return;
      }
      if (entry.type !== 'Directory') {
        const hasher = new Bun.CryptoHasher('sha256');
        let bytes = 0;
        entry.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
          hasher.update(chunk);
        });
        entry.on('end', () => {
          records.push({
            path,
            executable: Boolean((entry.mode ?? 0) & 0o111),
            bytes,
            digest: hasher.digest('hex'),
          });
        });
        entry.resume();
      } else {
        entry.resume();
      }
    },
  });
  return new Promise((resolve, reject) => {
    parser.once('error', reject);
    parser.once('end', () => {
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      const files = records
        .toSorted((left, right) => comparePaths(left.path, right.path))
        .map(({ path, executable }) => ({ path, executable }));
      resolve({ algorithm: packagePayloadAlgorithm, files, digest: digestRecords(records) });
    });
    parser.end(Buffer.from(archive));
  });
}
