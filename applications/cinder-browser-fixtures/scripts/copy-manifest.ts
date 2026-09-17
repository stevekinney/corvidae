import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const sourcePath = resolve(import.meta.dirname, '..', '.playwright', 'manifest.json');
const outputPath = resolve(import.meta.dirname, '..', 'build', '.playwright', 'manifest.json');

await mkdir(resolve(outputPath, '..'), { recursive: true });
await Bun.write(outputPath, await Bun.file(sourcePath).text());
