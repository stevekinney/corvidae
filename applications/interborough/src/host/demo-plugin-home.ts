/**
 * Turns the demo plugin on for a home. The plugin is off by default (`enabledByDefault: false`),
 * so a host whose scripted agents (`demo:assistant` and the rest) must be there, such as the
 * showcase development host and the end-to-end hosts, enables it in the home's `configuration.json`
 * before the host starts, keeping whatever the file already holds.
 *
 * @module demo-plugin-home
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

/** Enable the demo plugin in `home`'s `configuration.json`, keeping every other key it holds. */
export async function enableDemoPlugin(home: string): Promise<void> {
  const path = join(home, 'configuration.json');
  const document = await readDocument(path);
  const plugins = isRecord(document['plugins']) ? document['plugins'] : {};
  const demo = isRecord(plugins['demo']) ? plugins['demo'] : {};
  await mkdir(home, { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ ...document, plugins: { ...plugins, demo: { ...demo, enabled: true } } }),
  );
}
