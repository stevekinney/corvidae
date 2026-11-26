/** Remove absolute locations from stack frames, retaining the source name and coordinates. */
export function displayStack(stack: string): string {
  return stack
    .split('\n')
    .map((line) => {
      if (!/^\s*at\s/.test(line) && !/^.*@(?:file:\/\/|\/|[A-Za-z]:[\\/]|\\\\)/.test(line))
        return line;
      return line.replace(
        /(?<![\w.:/\\-])(?:file:\/\/)?(?:\/|[A-Za-z]:[\\/]|\\\\)[^\n]*?(?=(?::\d+(?::\d+)?)?\)?\s*$)/g,
        (path) => {
          const name = path.split(/[\\/]/).at(-1);
          return `[path]/${name ?? ''}`;
        },
      );
    })
    .join('\n');
}

/** Omit the engine's own run identifier from a confirmed document activity envelope. */
export function displayDocumentActivityInput(summary: string, workflowId: string): string {
  try {
    const parsed: unknown = JSON.parse(summary);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return summary;
    const record = parsed as Record<string, unknown>;
    if (
      record['workflowId'] !== workflowId ||
      !Number.isSafeInteger(record['step']) ||
      typeof record['stepAddress'] !== 'string' ||
      !Object.hasOwn(record, 'input') ||
      !Object.hasOwn(record, 'trigger') ||
      !Object.hasOwn(record, 'previous')
    )
      return summary;
    const { workflowId: _workflowId, ...visible } = record;
    return JSON.stringify(visible);
  } catch {
    return summary;
  }
}
