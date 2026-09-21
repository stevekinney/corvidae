#!/usr/bin/env bun
import { rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Removes only this application's own build output.
 *
 * `.hutch` is deliberately absent: it holds the Electrobun devkit projected by
 * `electrobun prepare`, which is a cached download rather than build output.
 * Removing it would make the next check re-download the whole SDK.
 */
const projectRoot = path.dirname(import.meta.dir);
const removable = ['dist', 'build', 'artifacts', '.cottontail-tmp'];

await Promise.all(
  removable.map((directory) =>
    rm(path.join(projectRoot, directory), { force: true, recursive: true }),
  ),
);

console.log(`Removed ${removable.join(', ')}.`);
