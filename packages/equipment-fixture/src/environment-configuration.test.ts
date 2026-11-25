import { expect, test } from 'bun:test';
import { parseEquipmentEnvironment } from './environment-configuration.ts';

test('reads fixture configuration and the optional listener port from explicit values', () => {
  const values = {
    PUBLIC_ORIGIN: 'https://example.test',
    OIDC_ISSUER: 'https://issuer.test',
    OIDC_CLIENT_ID: 'client',
    OIDC_CLIENT_SECRET: 'secret',
    READER_SUBJECT: 'reader',
    EDITOR_SUBJECT: 'editor',
    SQLITE_PATH: '/data/equipment.sqlite',
  };
  expect(parseEquipmentEnvironment(values)).toEqual({
    origin: values.PUBLIC_ORIGIN,
    issuer: values.OIDC_ISSUER,
    clientId: values.OIDC_CLIENT_ID,
    clientSecret: values.OIDC_CLIENT_SECRET,
    reader: values.READER_SUBJECT,
    editor: values.EDITOR_SUBJECT,
    sqlitePath: values.SQLITE_PATH,
    port: 3000,
  });
  expect(parseEquipmentEnvironment({ ...values, PORT: '4123' }).port).toBe(4123);
  expect(() => parseEquipmentEnvironment({ ...values, OIDC_CLIENT_SECRET: '' })).toThrow(
    'Missing OIDC_CLIENT_SECRET',
  );
});
