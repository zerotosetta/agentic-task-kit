import type {
  Artifact,
  ArtifactStore,
  ExecutionEvent,
  RunArtifact
} from "./types.js";
import { ExecutionBroadcaster } from "./events.js";

type ArtifactStoreEventType = "artifact.created";
type ArtifactStoreEvent = {
  type: ArtifactStoreEventType;
  timestamp: number;
  workflowId: string;
  runId: string;
  summary: string;
  meta?: Record<string, unknown>;
};

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, Artifact>();
  private nextId = 1;

  async create(args: {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    meta?: Record<string, unknown>;
  }): Promise<Artifact> {
    const artifactId = `artifact_${this.nextId++}`;
    const artifact: Artifact = {
      artifactId,
      name: args.name,
      mimeType: args.mimeType,
      uri: `memory://${artifactId}/${args.name}`,
      createdAt: Date.now(),
      meta: {
        byteLength: args.bytes.byteLength,
        ...args.meta
      }
    };

    this.artifacts.set(artifactId, artifact);
    return artifact;
  }

  async get(artifactId: string): Promise<Artifact | null> {
    return this.artifacts.get(artifactId) ?? null;
  }

  async list(prefix?: string): Promise<Artifact[]> {
    const artifacts = [...this.artifacts.values()];
    if (!prefix) {
      return artifacts;
    }

    return artifacts.filter((artifact) => artifact.name.startsWith(prefix));
  }
}

type ObservedArtifactStoreArgs = {
  store: ArtifactStore;
  broadcaster: ExecutionBroadcaster;
  workflowId: string;
  runId: string;
  now: () => number;
  onCreate?: (artifact: RunArtifact) => void | Promise<void>;
};

export function createObservedArtifactStore(args: ObservedArtifactStoreArgs): ArtifactStore {
  const emit = async (
    type: ArtifactStoreEventType,
    summary: string,
    meta?: Record<string, unknown>
  ): Promise<void> => {
    const event: ArtifactStoreEvent = {
      type,
      timestamp: args.now(),
      workflowId: args.workflowId,
      runId: args.runId,
      summary
    };

    if (meta !== undefined) {
      event.meta = meta;
    }

    await args.broadcaster.emit(event as ExecutionEvent);
  };

  return {
    async create(input) {
      const artifact = await args.store.create(input);
      await args.onCreate?.({
        ...artifact,
        bytes: new Uint8Array(input.bytes)
      });
      await emit("artifact.created", `artifact created ${artifact.name}`, {
        artifactId: artifact.artifactId,
        name: artifact.name,
        mimeType: artifact.mimeType
      });
      return artifact;
    },
    async get(artifactId) {
      return args.store.get(artifactId);
    },
    async list(prefix) {
      return args.store.list(prefix);
    }
  };
}
