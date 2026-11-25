import ts from 'typescript';

export function callerOf(node: ts.Node, tree: ts.SourceFile): string {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name)
      return current.name.getText(tree);
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent)
    )
      return current.parent.name.getText(tree);
  }
  return '<module>';
}

function fetchReference(node: ts.Node, aliases: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(node)) return aliases.has(node.text);
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'fetch';
  if (ts.isElementAccessExpression(node))
    return ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'fetch';
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    return fetchReference(node.expression, aliases);
  if (ts.isBinaryExpression(node))
    return fetchReference(node.left, aliases) || fetchReference(node.right, aliases);
  if (ts.isConditionalExpression(node))
    return fetchReference(node.whenTrue, aliases) || fetchReference(node.whenFalse, aliases);
  return false;
}

function anchor(node: ts.Node, tree: ts.SourceFile): string {
  if (ts.isCallExpression(node)) return node.getText(tree).replace(/\s+/gu, ' ');
  let variable: ts.VariableDeclaration | undefined;
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current))
      return `sha256:${new Bun.CryptoHasher('sha256').update(current.getText(tree)).digest('hex')}`;
    if (ts.isVariableDeclaration(current) && !variable) variable = current;
  }
  return `sha256:${new Bun.CryptoHasher('sha256').update((variable ?? node).getText(tree)).digest('hex')}`;
}

/** Find fetch calls and the bindings that can carry an injected fetch implementation. */
export function scanTransport(
  path: string,
  tree: ts.SourceFile,
): { calls: string[]; aliases: Set<string> } {
  const aliases = new Set(['fetch']);
  const assignments: { name: string; expression: ts.Expression }[] = [];
  function collectBinding(name: ts.BindingName): void {
    if (ts.isObjectBindingPattern(name))
      for (const element of name.elements) {
        if (
          (element.propertyName?.getText(tree) ?? element.name.getText(tree)) === 'fetch' &&
          ts.isIdentifier(element.name)
        )
          aliases.add(element.name.text);
      }
  }
  function collect(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.initializer)
        assignments.push({ name: node.name.text, expression: node.initializer });
      collectBinding(node.name);
    }
    if (ts.isParameter(node)) {
      collectBinding(node.name);
      if (ts.isIdentifier(node.name) && node.initializer)
        assignments.push({ name: node.name.text, expression: node.initializer });
      if (
        ts.isIdentifier(node.name) &&
        node.type &&
        ((ts.isTypeReferenceNode(node.type) &&
          /(?:Fetcher|FetchFunction|FetchImplementation|FetchLike)$/u.test(
            node.type.typeName.getText(tree),
          )) ||
          (ts.isTypeQueryNode(node.type) &&
            /(?:^|\.)fetch$/u.test(node.type.exprName.getText(tree))) ||
          (ts.isFunctionTypeNode(node.type) &&
            /\bRequestInfo\b/u.test(node.type.getText(tree)) &&
            /\bResponse\b/u.test(node.type.getText(tree))))
      )
        aliases.add(node.name.text);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    )
      assignments.push({ name: node.left.text, expression: node.right });
    ts.forEachChild(node, collect);
  }
  collect(tree);
  let changed = true;
  while (changed) {
    changed = false;
    for (const assignment of assignments)
      if (!aliases.has(assignment.name) && fetchReference(assignment.expression, aliases)) {
        aliases.add(assignment.name);
        changed = true;
      }
  }
  const calls: string[] = [];
  function visit(node: ts.Node): void {
    const call = ts.isCallExpression(node) && fetchReference(node.expression, aliases);
    const property =
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      fetchReference(node, aliases) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node);
    const binding =
      ts.isBindingElement(node) &&
      (node.propertyName?.getText(tree) ?? node.name.getText(tree)) === 'fetch';
    const parameter =
      ts.isParameter(node) &&
      ts.isIdentifier(node.name) &&
      aliases.has(node.name.text) &&
      node.type !== undefined;
    const reference =
      ts.isIdentifier(node) &&
      node.text === 'fetch' &&
      ((ts.isVariableDeclaration(node.parent) && node.parent.initializer === node) ||
        (ts.isParameter(node.parent) && node.parent.initializer === node) ||
        (ts.isBinaryExpression(node.parent) &&
          (node.parent.left === node || node.parent.right === node)));
    if (call || property || binding || parameter || reference)
      calls.push(`${path} ${callerOf(node, tree)} ${anchor(node, tree)}`);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return { calls, aliases };
}

export function assertClassified(actual: readonly string[], expected: readonly string[]): void {
  const remaining = [...expected];
  for (const entry of actual) {
    const index = remaining.indexOf(entry);
    if (index < 0) throw new Error(`Unclassified call: ${entry}`);
    remaining.splice(index, 1);
  }
  if (remaining.length) throw new Error(`Stale inventory: ${remaining.join(', ')}`);
}
