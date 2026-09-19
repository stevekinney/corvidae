import { describe, expect, it } from 'bun:test';

import {
  createPostgresTestServer,
  postgresCommandEnvironment,
} from './postgres-server.test-support.ts';

const ambient = {
  PATH: '/usr/local/bin:/usr/bin',
  HOME: '/Users/corvidae',
  TMPDIR: '/var/folders/corvidae/',
  PGDATA: '/Users/corvidae/Library/Application Support/Postgres/data',
  PGHOST: 'production.example.com',
  PGPORT: '5432',
  PGUSER: 'owner',
  PGPASSWORD: 'not-a-secret-in-this-fixture',
} as const;

describe('disposable PostgreSQL harness environment', () => {
  it('pins LC_ALL so the postmaster stays single-threaded on macOS', () => {
    expect(postgresCommandEnvironment({ PATH: ambient.PATH })['LC_ALL']).toBe('C');
  });

  it('overrides an ambient locale rather than inheriting it', () => {
    expect(postgresCommandEnvironment({ LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' })).toEqual({
      LC_ALL: 'C',
      LANG: 'en_US.UTF-8',
    });
  });

  it('forwards the ambient variables initdb and pg_ctl need', () => {
    const environment = postgresCommandEnvironment(ambient);

    expect(environment['PATH']).toBe(ambient.PATH);
    expect(environment['HOME']).toBe(ambient.HOME);
    expect(environment['TMPDIR']).toBe(ambient.TMPDIR);
  });

  it('drops every ambient PostgreSQL variable so the cluster stays self-contained', () => {
    const environment = postgresCommandEnvironment(ambient);

    for (const name of ['PGDATA', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD']) {
      expect(Object.hasOwn(environment, name), name).toBe(false);
    }
  });

  it('leaves the caller-supplied environment untouched', () => {
    const supplied = { PGHOST: 'production.example.com', LANG: 'en_US.UTF-8' };

    postgresCommandEnvironment(supplied);

    expect(supplied).toEqual({ PGHOST: 'production.example.com', LANG: 'en_US.UTF-8' });
  });

  it('starts a cluster that accepts connections', async () => {
    await using server = await createPostgresTestServer();

    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`postgresql://corvidae_test@127.0.0.1:${server.port}/postgres`);

    const socket = await Bun.connect({
      hostname: '127.0.0.1',
      port: server.port,
      socket: { data: () => {} },
    });
    socket.end();
  });
});
