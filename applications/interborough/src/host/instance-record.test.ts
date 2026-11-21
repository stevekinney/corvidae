/**
 * The record a running host leaves in its home (COR-2540): written with the address it bound and its
 * process identifier, removed on a clean exit, and trusted by a reader only while that process is
 * alive and the recorded address answers the host's status route.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'node:path';
import { HOST_STATUS_ROUTE } from './host-status.ts';
import { startHost, type Host } from './host.ts';
import {
  instanceRecordPath,
  liveInstanceUrl,
  readInstanceRecord,
  removeInstanceRecord,
  writeInstanceRecord,
} from './instance-record.ts';

const directories: string[] = [];
const hosts: Host[] = [];
const servers: Array<{ stop(force?: boolean): unknown }> = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const server of servers.splice(0)) await server.stop(true);
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-instance-record-'));
  directories.push(directory);
  return directory;
}

/** A listener that answers the host's status route as `status` says, standing in for a host. */
function statusServer(status: number): { readonly url: string } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === HOST_STATUS_ROUTE
        ? new Response('{}', { status })
        : new Response('not found', { status: 404 }),
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}` };
}

const ALIVE = () => true;
const DEAD = () => false;

describe('the record', () => {
  test('holds the address and the process identifier, and reads back as written', async () => {
    const home = await scratch();
    await writeInstanceRecord(home, { url: 'http://127.0.0.1:54321', pid: 4242 });
    expect(JSON.parse(await readFile(instanceRecordPath(home), 'utf8'))).toEqual({
      url: 'http://127.0.0.1:54321',
      pid: 4242,
    });
    expect(await readInstanceRecord(home)).toEqual({ url: 'http://127.0.0.1:54321', pid: 4242 });
  });

  test('is removed by the process that wrote it, and a record already gone is no failure', async () => {
    const home = await scratch();
    await writeInstanceRecord(home, { url: 'http://127.0.0.1:54321', pid: 4242 });
    await removeInstanceRecord(home, 4242);
    expect(await readInstanceRecord(home)).toBeUndefined();
    await removeInstanceRecord(home, 4242);
  });

  test('is left alone by a process that did not write it, so a replaced host cannot erase its successor', async () => {
    const home = await scratch();
    await writeInstanceRecord(home, { url: 'http://127.0.0.1:54321', pid: 5151 });
    await removeInstanceRecord(home, 4242);
    expect(await readInstanceRecord(home)).toEqual({ url: 'http://127.0.0.1:54321', pid: 5151 });
  });

  test.each([
    ['not JSON', 'nope'],
    ['not an object', '[1]'],
    ['no address', '{"pid":1}'],
    ['no process', '{"url":"http://127.0.0.1:1"}'],
    ['a fractional process', '{"url":"http://127.0.0.1:1","pid":1.5}'],
    ['a process of zero', '{"url":"http://127.0.0.1:1","pid":0}'],
    ['an address that is not http', '{"url":"file:///etc/passwd","pid":1}'],
    ['an address that is not an address', '{"url":"nonsense","pid":1}'],
    ['an address that is not loopback', '{"url":"http://example.com:7234","pid":1}'],
    ['an address with no port', '{"url":"http://127.0.0.1","pid":1}'],
  ])('reads %s as no record', async (_name, contents) => {
    const home = await scratch();
    await writeFile(instanceRecordPath(home), contents);
    expect(await readInstanceRecord(home)).toBeUndefined();
  });

  test('reads a missing file as no record', async () => {
    expect(await readInstanceRecord(await scratch())).toBeUndefined();
  });
});

describe('liveInstanceUrl', () => {
  test('is the recorded address while its process is alive and the address answers the status route', async () => {
    const home = await scratch();
    const { url } = statusServer(200);
    await writeInstanceRecord(home, { url, pid: process.pid });
    expect(await liveInstanceUrl(home)).toBe(url);
  });

  test('ignores the record when the process is gone, without asking the address', async () => {
    const home = await scratch();
    await writeInstanceRecord(home, { url: 'http://127.0.0.1:54321', pid: 4242 });
    const unreachable = async (): Promise<Response> => {
      throw new Error('A dead process’s address must not be asked.');
    };
    expect(await liveInstanceUrl(home, { alive: DEAD, fetch: unreachable })).toBeUndefined();
  });

  test('ignores the record when the address does not answer the status route', async () => {
    const home = await scratch();
    const { url } = statusServer(503);
    await writeInstanceRecord(home, { url, pid: process.pid });
    expect(await liveInstanceUrl(home)).toBeUndefined();
  });

  test('ignores the record when nothing listens at the address, though the process is alive', async () => {
    const home = await scratch();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const url = `http://127.0.0.1:${server.port}`;
    await server.stop(true);
    await writeInstanceRecord(home, { url, pid: process.pid });
    expect(await liveInstanceUrl(home, { alive: ALIVE })).toBeUndefined();
  });

  test('is undefined for a home with no record', async () => {
    expect(await liveInstanceUrl(await scratch())).toBeUndefined();
  });
});

describe('a running host', () => {
  async function start(): Promise<{ host: Host; home: string }> {
    const home = await scratch();
    const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
    hosts.push(host);
    return { host, home };
  }

  test('records the address it bound and its process, and the record answers the status route', async () => {
    const { host, home } = await start();
    expect(await readInstanceRecord(home)).toEqual({
      url: host.url.origin,
      pid: process.pid,
    });
    expect(await liveInstanceUrl(home)).toBe(host.url.origin);
  });

  test('records the port the system gave it when it asked for any free port', async () => {
    const { host, home } = await start();
    const record = await readInstanceRecord(home);
    expect(Number(new URL(record!.url).port)).toBe(Number(host.url.port));
    expect(Number(host.url.port)).toBeGreaterThan(0);
  });

  test('removes the record on a clean exit', async () => {
    const { host, home } = await start();
    expect(await readInstanceRecord(home)).toBeDefined();
    await host.close();
    expect(await readInstanceRecord(home)).toBeUndefined();
  });

  test('leaves a record it did not write when it closes, which is how a successor survives', async () => {
    const { host, home } = await start();
    await writeInstanceRecord(home, { url: 'http://127.0.0.1:1', pid: process.pid + 1 });
    await host.close();
    expect(await readInstanceRecord(home)).toEqual({
      url: 'http://127.0.0.1:1',
      pid: process.pid + 1,
    });
  });
});
