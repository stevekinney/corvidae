export class EvidenceRequestError extends Error {}

export interface ProviderRun {
  repository: string;
  revision: string;
  status: string;
  conclusion: string;
  workflow: string;
  event: string;
  attempt: number;
}

export interface ProviderJob {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  runtime: string;
  inventory: string[];
  assertionPassed: boolean | null;
}

export interface ProviderArtifact {
  present: boolean;
  expired: boolean;
  id?: number;
  digest?: string;
  runId?: number;
  revision?: string;
}

export interface ProviderEvidenceTransport {
  run(id: number): ProviderRun;
  job(id: number, job: string): ProviderJob;
  artifact(id: number, artifact: string): ProviderArtifact;
  downloadArtifact?(artifactId: number): Uint8Array;
  content?(
    revision: string,
    base: string,
    inputs: string[],
  ): {
    integrationTree: string;
    relevantInputs: string[];
  };
}
