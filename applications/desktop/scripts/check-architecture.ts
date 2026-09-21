#!/usr/bin/env bun
import path from 'node:path';

import { assertSourceBoundary } from './architecture-analysis.ts';
import { architectureBoundaries, isForbiddenToolchainPackage } from './architecture-boundaries.ts';

const projectRoot = path.dirname(import.meta.dir);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const packageJson: unknown = await Bun.file(path.join(projectRoot, 'package.json')).json();
if (!isRecord(packageJson)) {
  throw new TypeError('package.json must contain an object.');
}

for (const section of [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides',
  'resolutions',
] as const) {
  const dependencies = packageJson[section];
  if (!isRecord(dependencies)) continue;

  for (const name of Object.keys(dependencies)) {
    if (isForbiddenToolchainPackage(name)) {
      throw new Error(`${name} is forbidden: this template uses Bun.build.`);
    }
  }
}

for (const boundary of architectureBoundaries) {
  for (const pattern of boundary.files) {
    const files = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: projectRoot }));
    for (const file of files) {
      const contents = await Bun.file(path.join(projectRoot, file)).text();
      assertSourceBoundary(projectRoot, file, contents, boundary);
    }
  }
}

console.log('Architecture boundaries and toolchain dependencies are valid.');
