/**
 * Turns plugins on or off for a home, the demo plugin above all. The plugin is off by default (`enabledByDefault: false`),
 * so a host whose scripted agents (`demo:assistant` and the rest) must be there, such as the
 * showcase development host and the end-to-end hosts, enables it in the home's `configuration.json`
 * before the host starts, keeping whatever the file already holds.
 *
 * @module demo-plugin-home
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { openBungalow } from '@lostgradient/bungalow';

/** Whether `value` is a plain object, so its keys can be read. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON object in `path`, or an empty one when there is no such file. */
async function readDocument(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  const document: unknown = JSON.parse(text);
  if (!isRecord(document)) throw new Error(`${path} does not hold a JSON object.`);
  return document;
}

/**
 * Turn each plugin `choices` names on or off in `home`'s `configuration.json`, keeping every other
 * key it holds, the plugins' configurations included.
 */
export async function setPluginsEnabled(
  home: string,
  choices: Readonly<Record<string, boolean>>,
): Promise<void> {
  await mkdir(home, { recursive: true });
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { NODE_ENV: 'test', INTERBOROUGH_HOME: home },
  });
  bungalow.close();
  const path = join(home, 'configuration.json');
  const document = await readDocument(path);
  const plugins: Record<string, unknown> = isRecord(document['plugins'])
    ? { ...document['plugins'] }
    : {};
  for (const [name, enabled] of Object.entries(choices)) {
    const entry = Object.hasOwn(plugins, name) ? plugins[name] : undefined;
    plugins[name] = { ...(isRecord(entry) ? entry : {}), enabled };
  }
  await writeFile(path, JSON.stringify({ ...document, plugins }));
}

/** Enable the demo plugin in `home`'s `configuration.json`, keeping every other key it holds. */
export async function enableDemoPlugin(home: string): Promise<void> {
  await setPluginsEnabled(home, { demo: true });
}
