import { basename } from 'node:path';
import ts from 'typescript';
import type { Plugin } from 'vite';

type GrammarData = { start: number; end: number; json: string };

function propertyCall(
  node: ts.Node,
  receiver: string,
  property: string,
): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === receiver &&
    node.expression.name.text === property
  );
}

/** Locate Shiki's frozen grammar payload without evaluating package code. */
export function readGrammarData(source: string, path: string): GrammarData | undefined {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let data: GrammarData | undefined;
  function visit(node: ts.Node): void {
    if (propertyCall(node, 'Object', 'freeze')) {
      const parse = node.arguments[0];
      if (parse && propertyCall(parse, 'JSON', 'parse')) {
        const literal = parse.arguments[0];
        if (literal && ts.isStringLiteral(literal)) {
          if (data) throw new Error(`Multiple frozen grammar payloads in ${path}`);
          data = { start: parse.getStart(tree), end: parse.end, json: literal.text };
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return data;
}

/** Keep Shiki's imports, exports and freeze operation; load only its data as an asset. */
export function replaceGrammarData(
  source: string,
  data: GrammarData,
  urlExpression: string,
): string {
  const expression = `await fetch(${urlExpression}).then(response => {
    if (!response.ok) throw new Error('Shiki grammar request failed: ' + response.status);
    return response.json();
  })`;
  return source.slice(0, data.start) + expression + source.slice(data.end);
}

/** Emit large language data as normal application assets instead of JavaScript strings. */
export function shikiGrammarAssets(): Plugin {
  return {
    name: 'vite-plugin-shiki-grammar-assets',
    apply: 'build',
    applyToEnvironment: (environment) => environment.config.consumer === 'client',
    transform: {
      filter: { id: /\/node_modules\/@shikijs\/langs\/dist\/[^/]+\.mjs$/ },
      handler(source, id) {
        const data = readGrammarData(source, id);
        if (!data) return null;
        const reference = this.emitFile({
          type: 'asset',
          name: `shiki-${basename(id, '.mjs')}.json`,
          source: data.json,
        });
        return {
          code: replaceGrammarData(source, data, `import.meta.ROLLUP_FILE_URL_${reference}`),
          map: null,
        };
      },
    },
  };
}
