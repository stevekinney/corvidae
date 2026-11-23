import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ComponentKnowledgeError, type ManifestComponent } from './types.js';

export async function loadArtifact(
  component: ManifestComponent,
  kind: 'schema' | 'variables' | 'examples' | 'constraints',
  packageRoot: string,
): Promise<unknown> {
  const missing = () =>
    new ComponentKnowledgeError(
      'ARTIFACT_NOT_FOUND',
      `${component.id} does not have a local ${kind} artifact.`,
      [component.id],
    );
  const artifactPath = component.artifacts[kind];
  if (artifactPath === undefined) throw missing();

  const directory = await realpath(packageRoot);
  const candidate = resolve(directory, artifactPath);
  const asset = await realpath(candidate).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw missing();
    }
    throw error;
  });
  const pathWithinPackage = relative(directory, asset);
  if (
    isAbsolute(artifactPath) ||
    isAbsolute(pathWithinPackage) ||
    (!pathWithinPackage.startsWith(`.metadata${sep}`) &&
      !pathWithinPackage.startsWith(`src${sep}components${sep}`))
  ) {
    throw missing();
  }
  return JSON.parse(await readFile(asset, 'utf8'));
}
