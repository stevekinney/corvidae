function required(values: Record<string, string | undefined>, name: string): string {
  const value = Object.hasOwn(values, name) ? values[name] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function parseEquipmentEnvironment(values: Record<string, string | undefined>) {
  return {
    origin: required(values, 'PUBLIC_ORIGIN'),
    issuer: required(values, 'OIDC_ISSUER'),
    clientId: required(values, 'OIDC_CLIENT_ID'),
    clientSecret: required(values, 'OIDC_CLIENT_SECRET'),
    reader: required(values, 'READER_SUBJECT'),
    editor: required(values, 'EDITOR_SUBJECT'),
    sqlitePath: required(values, 'SQLITE_PATH'),
    port: Number((Object.hasOwn(values, 'PORT') ? values['PORT'] : undefined) ?? '3000'),
  };
}

export function readEquipmentEnvironment() {
  return parseEquipmentEnvironment({
    PUBLIC_ORIGIN: process.env['PUBLIC_ORIGIN'],
    OIDC_ISSUER: process.env['OIDC_ISSUER'],
    OIDC_CLIENT_ID: process.env['OIDC_CLIENT_ID'],
    OIDC_CLIENT_SECRET: process.env['OIDC_CLIENT_SECRET'],
    READER_SUBJECT: process.env['READER_SUBJECT'],
    EDITOR_SUBJECT: process.env['EDITOR_SUBJECT'],
    SQLITE_PATH: process.env['SQLITE_PATH'],
    PORT: process.env['PORT'],
  });
}

export type EquipmentEnvironment = ReturnType<typeof parseEquipmentEnvironment>;
