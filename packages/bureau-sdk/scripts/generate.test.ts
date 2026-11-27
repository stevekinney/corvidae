import { createBureauCatalogSnapshot } from '@lostgradient/bureau';
import { expect, it } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CATALOG_OPERATION_BEHAVIORS } from '../src/bureau-generated/operation-behaviors.generated.ts';
import {
  CATALOG_OPERATION_NAMES,
  CLIENT_OPERATION_NAMES,
  SUBSCRIPTION_OPERATION_NAMES,
} from '../src/bureau-generated/operation-client.generated.ts';
import {
  bureauOutputDirectory,
  createBureauClientSources,
  createReviewsClientSources,
  outputDirectory,
} from './generate.ts';

it('generates the same committed bytes twice', async () => {
  const first = await createReviewsClientSources();
  const second = await createReviewsClientSources();
  expect([...first]).toEqual([...second]);
  const files = await readdir(outputDirectory);
  expect(files.toSorted()).toEqual([...first.keys()].toSorted());
  for (const [name, source] of first)
    expect(await Bun.file(join(outputDirectory, name)).text()).toBe(source);
});

it('generates the served Bureau inventory deterministically', async () => {
  const first = await createBureauClientSources();
  expect([...first]).toEqual([...(await createBureauClientSources())]);
  const files = await readdir(bureauOutputDirectory);
  expect(files.toSorted()).toEqual([...first.keys()].toSorted());
  for (const [name, source] of first)
    expect(await Bun.file(join(bureauOutputDirectory, name)).text()).toBe(source);
  const operations = createBureauCatalogSnapshot().operations;
  expect([...CATALOG_OPERATION_NAMES].toSorted()).toEqual(
    operations
      .filter((operation) => operation.kind === 'unary' && operation.transports.jsonRpcHttp)
      .map((operation) => operation.name)
      .toSorted(),
  );
  expect([...CLIENT_OPERATION_NAMES].toSorted()).toEqual(
    operations
      .filter((operation) => {
        if (operation.kind !== 'unary') return false;
        if (operation.transports.jsonRpcHttp) return true;
        const rest = operation.rest;
        return (
          operation.transports.http &&
          rest !== undefined &&
          rest.success.kind !== 'streaming' &&
          Object.values(rest.inputSources).every(
            (source) => source.kind !== 'body' || source.mediaType !== 'application/octet-stream',
          )
        );
      })
      .map((operation) => operation.name)
      .toSorted(),
  );
  expect([...SUBSCRIPTION_OPERATION_NAMES].toSorted()).toEqual(
    operations
      .filter((operation) => operation.kind === 'subscription' && operation.transports.http)
      .map((operation) => operation.name)
      .toSorted(),
  );
  expect(Object.keys(CATALOG_OPERATION_BEHAVIORS).toSorted()).toEqual(
    operations.map((operation) => operation.name).toSorted(),
  );
  expect(CATALOG_OPERATION_BEHAVIORS['bureau.reviews.resolve'].behavior.conflictReasons).toEqual([
    'REVIEW_ROUND_CHANGED',
    'REVIEW_ALREADY_RESOLVED',
    'APPROVAL_OUTCOME_NOT_WRITTEN',
  ]);
  expect(
    CATALOG_OPERATION_BEHAVIORS['bureau.reviews.resolve'].behavior.observedInput,
  ).toMatchObject({ read: 'bureau.reviews.get', key: 'id', revision: 'round' });
  const svelte = first.get('operation-client.svelte.ts');
  if (!svelte) throw new Error('missing Svelte bindings');
  const generated = [...svelte.matchAll(/export function use(\w+)\(/gu)]
    .map((match) => match[1])
    .toSorted();
  const expected = operations
    .filter(
      (operation) =>
        operation.behavior &&
        ((operation.kind === 'unary' &&
          (operation.transports.jsonRpcHttp || operation.transports.http)) ||
          (operation.kind === 'subscription' &&
            operation.transports.http &&
            operation.behavior.kind === 'read' &&
            operation.behavior.cursor)),
    )
    .map((operation) =>
      operation.name
        .split(/[^A-Za-z0-9]+/u)
        .filter(Boolean)
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join(''),
    )
    .toSorted();
  expect(generated).toEqual(expected);
});

it('bundles the plain SDK for browsers and server loads without UI or server modules', async () => {
  for (const target of ['browser', 'node'] as const) {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, '../src/client.ts')],
      target,
      metafile: true,
    });
    expect(build.success).toBe(true);
    const inputs = Object.keys(build.metafile?.inputs ?? {});
    expect(inputs.length).toBeGreaterThan(0);
    expect(
      inputs.filter((path) => /(?:^|\/)(?:svelte|cinder|server|bureau\/src)(?:\/|$)/u.test(path)),
    ).toEqual([]);
  }
});
