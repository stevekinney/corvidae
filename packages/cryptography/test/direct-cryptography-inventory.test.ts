/**
 * The inventory of direct cryptography in production host source (COR-2775, after COR-2741's
 * sweep of `packages/`): a secret comparison or a SHA-256 routine belongs to
 * `@lostgradient/cryptography`, so source under `applications/interborough/src/host` calls
 * `timingSafeEqualText`, `timingSafeEqualHex`, `sha256HexSync`, `sha256BytesHexSync`,
 * `createIncrementalHash` and `hmacSha256HexSync`, and never `node:crypto`'s `createHash`,
 * `createHmac` or `timingSafeEqual`, `Bun.CryptoHasher` or `crypto.subtle`. The test reads the
 * syntax of every non-test file there, so a reintroduced duplicate fails here, by file and line.
 *
 * What stays direct is listed in {@link REMAINING_DIRECT_CALLS} by file and the primitive it needs.
 * The package offers no random identifier or token, so each remaining call is `randomUUID` (an
 * identifier) or `randomBytes` (the 32 random bytes of a sign-in reference or a start-override key).
 * Host credential policy and scopes stay in Interborough: this package supplies the primitives, and
 * `a2a-authentication.ts` and `engine-proxy.ts` decide which key admits which principal.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import ts from 'typescript';

/** What a source file calls that the package already provides. */
type DirectCall = {
  /** The primitive: an identifier such as `createHash`, `crypto.subtle`, or a `node:crypto` import such as `randomUUID`. */
  readonly primitive: string;
  /** The 1-based line it is on. */
  readonly line: number;
  /** Whether the package provides it, so the call is a duplicate wherever it appears. */
  readonly duplicate: boolean;
};

/** The identifiers of a comparison or a digest routine the package replaces. */
const DUPLICATE_IDENTIFIERS = new Set([
  'createHash',
  'createHmac',
  'timingSafeEqual',
  'CryptoHasher',
]);

const CRYPTO_MODULES = new Set(['node:crypto', 'crypto']);

/**
 * Every direct use of Node or Bun cryptography in `text`: a duplicate routine wherever it is
 * written, and each name taken from `node:crypto` (`*` for the whole module). Comments and
 * strings are not code, so a word in either is not a call.
 */
function directCryptography(text: string, fileName = 'file.ts'): readonly DirectCall[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const calls: DirectCall[] = [];
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const record = (node: ts.Node, primitive: string, duplicate: boolean) =>
    calls.push({ primitive, line: lineOf(node), duplicate });

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (CRYPTO_MODULES.has(node.moduleSpecifier.text)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            record(element, (element.propertyName ?? element.name).text, false);
          }
        } else if (node.importClause !== undefined) {
          record(node, '*', false);
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      CRYPTO_MODULES.has(node.arguments[0].text)
    ) {
      record(node, '*', false);
    } else if (ts.isIdentifier(node) && DUPLICATE_IDENTIFIERS.has(node.text)) {
      record(node, node.text, true);
    } else if (ts.isPropertyAccessExpression(node) && node.name.text === 'subtle') {
      record(node, 'crypto.subtle', true);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/**
 * What stays direct in host source, by file and primitive. A name is taken from `node:crypto` only
 * to make a random identifier or token, which the package does not offer. The list can only
 * shrink: a call it does not name fails, and so does an entry whose call is gone.
 */
const REMAINING_DIRECT_CALLS: Readonly<Record<string, readonly string[]>> = {
  'host-mutation-context.ts': ['randomUUID'],
  'host.ts': ['randomBytes', 'randomUUID'],
  'json-route-failure.ts': ['randomUUID'],
  'plugin-manager.ts': ['randomUUID'],
  'tool-source-oauth-session.ts': ['randomUUID'],
  'tool-source-pending-sign-ins.ts': ['randomBytes'],
  'tool-source-routes.ts': ['randomUUID'],
  'workspace-secrets.ts': ['randomUUID'],
};

describe('what counts as direct cryptography', () => {
  test('flags a hash, an HMAC, a timing-safe comparison, a hasher and Web Crypto digest, wherever written', () => {
    const calls = directCryptography(
      [
        "import { createHash as hash, timingSafeEqual } from 'node:crypto';",
        "import * as nodeCrypto from 'crypto';",
        "const a = hash('sha256');",
        "const b = nodeCrypto.createHmac('sha256', 'k');",
        "const c = new Bun.CryptoHasher('sha256');",
        "const d = await crypto.subtle.digest('SHA-256', bytes);",
        "const e = require('node:crypto');",
        "const f = await import('node:crypto');",
      ].join('\n'),
    );
    expect(calls.filter((call) => call.duplicate).map((call) => call.primitive)).toEqual([
      'createHash',
      'timingSafeEqual',
      'createHmac',
      'CryptoHasher',
      'crypto.subtle',
    ]);
    expect(calls.filter((call) => !call.duplicate).map((call) => call.primitive)).toEqual([
      'createHash',
      'timingSafeEqual',
      '*',
      '*',
      '*',
    ]);
  });

  test('does not flag a word in a comment or a string, or a name the package provides', () => {
    expect(
      directCryptography(
        [
          '// createHash and timingSafeEqual stay out of this file',
          "/** `new Bun.CryptoHasher('sha256')` */",
          "const note = 'createHash(timingSafeEqual)';",
          "import { sha256HexSync, timingSafeEqualText } from '@lostgradient/cryptography';",
          "import { randomUUID } from 'node:crypto';",
          'const id = crypto.randomUUID();',
        ].join('\n'),
      ),
    ).toEqual([{ primitive: 'randomUUID', line: 5, duplicate: false }]);
  });
});

describe('production host source', () => {
  const host = join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'applications',
    'interborough',
    'src',
    'host',
  );
  // Tests, their support and fixtures are not production host source.
  const production = (path: string) =>
    !/\.(?:test|spec|bench)\.ts$|\.test-support\.ts$|\.integration\.|\.slow\./.test(path) &&
    !/(?:^|\/)(?:__fixtures__|server-integration)\//.test(path);

  async function scan() {
    const files = [...new Bun.Glob('**/*.ts').scanSync({ cwd: host })]
      .filter(production)
      .toSorted();
    return Promise.all(
      files.map(async (file) => ({
        file,
        calls: directCryptography(await Bun.file(join(host, file)).text(), file),
      })),
    );
  }

  test('scans the files of the host directory', async () => {
    const scanned = await scan();
    expect(scanned.length).toBeGreaterThan(100);
    expect(scanned.map(({ file }) => file)).toContain('a2a-authentication.ts');
    expect(scanned.map(({ file }) => file)).toContain('engine-proxy.ts');
    expect(scanned.map(({ file }) => file)).toContain('tool-source-pending-sign-ins.ts');
    expect(scanned.map(({ file }) => file)).not.toContain('cryptography-vectors.test.ts');
  });

  test('has no duplicate comparison or digest routine', async () => {
    const duplicates = (await scan()).flatMap(({ file, calls }) =>
      calls
        .filter((call) => call.duplicate)
        .map((call) => `${file}:${call.line} ${call.primitive}`),
    );
    expect(duplicates).toEqual([]);
  });

  test('names every remaining direct call by file and primitive, and no call that is gone', async () => {
    const found = Object.fromEntries(
      (await scan())
        .map(
          ({ file, calls }) =>
            [
              file,
              [
                ...new Set(calls.filter((call) => !call.duplicate).map((call) => call.primitive)),
              ].toSorted(),
            ] as const,
        )
        .filter(([, primitives]) => primitives.length > 0),
    );
    expect(found).toEqual(
      Object.fromEntries(
        Object.entries(REMAINING_DIRECT_CALLS).map(([file, primitives]) => [
          file,
          [...primitives].toSorted(),
        ]),
      ),
    );
  });
});
