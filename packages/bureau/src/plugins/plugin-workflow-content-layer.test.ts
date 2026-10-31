/**
 * COR-1977 — the workflow files a running plugin ships (`content/workflows` under its `content`
 * URL) are a read-only layer beneath the owner's workflow sources, listed as `plugin:name`. A
 * plugin that is disabled or skipped ships nothing, an edit to a shipped file is read on the next
 * rescan with no restart, and the owner's sources keep working beside the layers composition adds.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { definePlugin } from '@lostgradient/interborough-plugin';
import { afterEach, describe, expect, it } from 'bun:test';

import { workflowFileDirectory } from '../sources/workflow-file-directory';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from '../testing/workflow-bureau.test-support';
import { workflowFileText } from '../testing/workflow-file-fixtures.test-support';
import { WorkflowFileError } from '../workflow-file';

const directories: string[] = [];
const harnesses: WorkflowBureauHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-plugin-workflow-content-'));
  directories.push(directory);
  return directory;
}

/** An hourly schedule, so no fire lands while a test runs. */
const HOURLY = { trigger: { kind: 'schedule', spec: '1h' } };

/** A content folder whose `workflows` folder holds `shipper:nightly`. */
async function contentWithWorkflow(description = 'first'): Promise<URL> {
  const content = await temporaryDirectory();
  await mkdir(join(content, 'workflows'));
  await writeFile(
    join(content, 'workflows', 'nightly.json'),
    workflowFileText('shipper:nightly', { ...HOURLY, description }),
  );
  return pathToFileURL(`${content}/`);
}

function shipper(content: URL | undefined) {
  return definePlugin({
    name: 'shipper',
    version: '1.0.0',
    description: 'Ships a workflow.',
    ...(content === undefined ? {} : { content }),
    setup: () => ({}),
  });
}

/** What the host that reads files supplies: `<content>/workflows` as the plugin's read-only layer. */
function pluginWorkflowSource(plugin: string, content: URL) {
  return content.protocol === 'file:'
    ? workflowFileDirectory(join(fileURLToPath(content), 'workflows'), { plugin, watch: false })
    : undefined;
}

async function start(options: {
  readonly content: URL | undefined;
  readonly enabled?: boolean;
  readonly reader?: boolean;
}) {
  const harness = await startWorkflowBureau({
    overrides: {
      ...(options.reader === false ? {} : { pluginWorkflowSource }),
      plugins: [
        { descriptor: shipper(options.content), source: 'package', location: '@example/shipper' },
      ],
      pluginConfiguration: { shipper: { enabled: options.enabled ?? true } },
    },
  });
  harnesses.push(harness);
  await harness.bureau.workflows?.refresh();
  return harness;
}

describe('the workflows a running plugin ships', () => {
  it('list as plugin:name, ready, and refuse a write as read-only', async () => {
    const { bureau } = await start({ content: await contentWithWorkflow() });
    const workflows = bureau.workflows;

    expect(workflows?.list().find((listing) => listing.id === 'shipper:nightly')).toMatchObject({
      state: 'ready',
    });
    const error = await workflows?.delete('shipper:nightly', { expectedHash: 'x' }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkflowFileError).code).toBe('workflow-file-read-only');
  });

  it('are read again after an edit, with no restart', async () => {
    const content = await contentWithWorkflow('first');
    const { bureau } = await start({ content });
    const before = await bureau.workflows?.get('shipper:nightly');
    expect(before?.description).toBe('first');

    await writeFile(
      join(fileURLToPath(content), 'workflows', 'nightly.json'),
      workflowFileText('shipper:nightly', { ...HOURLY, description: 'second' }),
    );
    await bureau.workflows?.refresh();

    const after = await bureau.workflows?.get('shipper:nightly');
    expect(after?.description).toBe('second');
  });

  it('keep the owner’s own workflows beside them', async () => {
    const harness = await start({ content: await contentWithWorkflow() });
    await harness.putWorkflow('mine', HOURLY);

    expect(harness.bureau.workflows?.list().map((listing) => listing.id)).toEqual(
      expect.arrayContaining(['mine', 'shipper:nightly']),
    );
  });

  it('are absent when the plugin is disabled', async () => {
    const { bureau } = await start({ content: await contentWithWorkflow(), enabled: false });

    expect(bureau.workflows?.list().map((listing) => listing.id)).not.toContain('shipper:nightly');
  });

  it('are none when the plugin declares no content', async () => {
    const { bureau } = await start({ content: undefined });

    expect(bureau.workflows?.list().some((listing) => listing.id.startsWith('shipper:'))).toBe(
      false,
    );
  });

  it('are none when the host supplies no reader for the content', async () => {
    const { bureau } = await start({ content: await contentWithWorkflow(), reader: false });

    expect(bureau.workflows?.list().some((listing) => listing.id.startsWith('shipper:'))).toBe(
      false,
    );
  });

  it('are none when the reader declines the content', async () => {
    const { bureau } = await start({ content: new URL('https://example.com/content/') });

    expect(bureau.workflows?.list().some((listing) => listing.id.startsWith('shipper:'))).toBe(
      false,
    );
  });
});
