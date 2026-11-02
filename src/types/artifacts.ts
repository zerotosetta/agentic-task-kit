export type Artifact = {
  artifactId: string;
  name: string;
  mimeType: string;
  uri: string;
  createdAt: number;
  meta?: Record<string, unknown>;
};

export type RunArtifact = Artifact & {
  bytes: Uint8Array;
};

export interface ArtifactStore {
  create(args: {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    meta?: Record<string, unknown>;
  }): Promise<Artifact>;
  get(artifactId: string): Promise<Artifact | null>;
  list(prefix?: string): Promise<Artifact[]>;
}
