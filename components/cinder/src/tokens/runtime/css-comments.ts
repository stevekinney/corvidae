export function sanitizeComment(description: string): string {
  return description.replaceAll('*/', '*\\/').replaceAll(/\s+/g, ' ').trim();
}
