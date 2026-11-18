export class EvidenceRequestError extends Error {}

export interface ProviderEvidenceTransport {
  run(id: number): { revision: string; status: string; conclusion: string; environment: string };
  job(
    id: number,
    job: string,
  ): { conclusion: string; inventory: string[]; assertionPassed: boolean | null };
  artifact(id: number, artifact: string): { present: boolean; id?: number; digest?: string };
  downloadArtifact?(artifactId: number): Uint8Array;
}
