import ts from 'typescript';

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
