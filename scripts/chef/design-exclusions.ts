// Coordinator-attested exceptions bind exact review text to one candidate and incoming base.
import { createHash } from 'node:crypto';

export const designDigest = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

/** Fingerprint a source row, including its origin so identical text in different files differs. */
export const designFingerprint = (origin: string, row: string): string =>
  designDigest(`${origin}\n${row}`);

interface Finding {
  fingerprint: string;
  eligible: boolean;
  label: string;
}

function findings(rows: string, ledger: string): Finding[] {
  const result: Finding[] = [];
  for (const row of rows.split('\n').filter((line) => line.trim() !== '')) {
    const [id = '', verdict = ''] = row.split('|').map((field) => field.trim());
    if (verdict !== 'matches' && verdict !== 'deferred')
      result.push({
        fingerprint: designFingerprint('verdict', row),
        eligible: verdict === 'drifted',
        label: `${id}: ${verdict}`,
      });
  }
  for (const row of ledger.split('\n').filter((line) => line.trim() !== '')) {
    const [kind = '', subject = '', verdict = ''] = row.split('|').map((field) => field.trim());
    if (
      (kind === 'screen' && (verdict === 'wrong' || verdict === 'unsure')) ||
      (kind === 'sweep' && verdict === 'found') ||
      (kind === 'state' && verdict === 'not captured')
    )
      result.push({
        fingerprint: designFingerprint('ledger', row),
        eligible: verdict === 'wrong' || verdict === 'found',
        label: `${kind} ${subject}: ${verdict}`,
      });
  }
  return result;
}

/** Validate the attestation and return remaining blockers, or a refusal. */
export function exclusionResult(
  text: string,
  head: string,
  base: string,
  rows: string,
  ledger: string,
): string[] {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'base,exclusions,head,ledgerDigest,verdictDigest' ||
      record.head !== head ||
      record.base !== base ||
      !/^[0-9a-f]{40}$/.test(base) ||
      record.verdictDigest !== designDigest(rows) ||
      record.ledgerDigest !== designDigest(ledger) ||
      !Array.isArray(record.exclusions) ||
      record.exclusions.length === 0
    )
      throw new Error();
    const all = findings(rows, ledger);
    const excluded = new Set<string>();
    for (const item of record.exclusions as unknown[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error();
      const entry = item as Record<string, unknown>;
      if (
        Object.keys(entry).sort().join(',') !==
          'baselineEvidence,fingerprint,issue,ownerApproval' ||
        typeof entry.fingerprint !== 'string' ||
        typeof entry.baselineEvidence !== 'string' ||
        entry.baselineEvidence.trim().length === 0 ||
        typeof entry.issue !== 'string' ||
        !/^https:\/\/linear\.app\/lost-gradient\/issue\/COR-\d+(?:\/[^?#]+)?$/.test(entry.issue) ||
        typeof entry.ownerApproval !== 'string' ||
        !/^https:\/\/linear\.app\/lost-gradient\/issue\/COR-\d+(?:\/[^?#]+)?#comment-[a-zA-Z0-9-]+$/.test(
          entry.ownerApproval,
        ) ||
        excluded.has(entry.fingerprint)
      )
        throw new Error();
      const matches = all.filter((finding) => finding.fingerprint === entry.fingerprint);
      if (matches.length !== 1 || !matches[0]?.eligible) throw new Error();
      excluded.add(entry.fingerprint);
    }
    return all
      .filter((finding) => !excluded.has(finding.fingerprint))
      .map((finding) => finding.label);
  } catch {
    return ['invalid or mismatched design exclusion attestation'];
  }
}
