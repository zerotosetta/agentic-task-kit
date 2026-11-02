import { createHash } from "node:crypto";
import type {
  EmbeddingProvider,
  GraphStore,
  KVStore,
  MemoryKind,
  MemoryRecord,
  MemoryShard,
  VectorStore,
} from "../types.js";
import { cosineSimilarity, normalizeQuery } from "./scoring.js";

export class DeterministicHashEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly dimensions = 16,
    private readonly modelId = "deterministic-hash-embedder",
  ) {}

  async embed(text: string): Promise<{ embedding: number[]; modelId: string }> {
    const normalized = normalizeQuery(text);
    const digest = createHash("sha256").update(normalized, "utf8").digest();
    const embedding = Array.from({ length: this.dimensions }, (_, index) => {
      const byte = digest[index % digest.length] ?? 0;
      return byte / 255;
    });

    return {
      embedding,
      modelId: this.modelId,
    };
  }
}

export class InMemoryKVStore implements KVStore {
  private readonly active = new Map<string, MemoryRecord>();
  private readonly archived = new Map<string, MemoryRecord>();

  async put(record: MemoryRecord): Promise<void> {
    const target = record.archivedAt ? this.archived : this.active;
    const opposite = record.archivedAt ? this.active : this.archived;
    opposite.delete(record.id);
    target.set(record.id, { ...record });
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.active.get(id) ?? this.archived.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    this.active.delete(id);
    this.archived.delete(id);
  }

  async archive(id: string, archivedAt: number): Promise<MemoryRecord | null> {
    const current = this.active.get(id);
    if (!current) {
      return null;
    }

    this.active.delete(id);
    const archived = {
      ...current,
      archivedAt,
    };
    this.archived.set(id, archived);
    return archived;
  }

  async list(args?: {
    shard?: MemoryShard;
    kind?: MemoryKind;
    archived?: boolean;
  }): Promise<MemoryRecord[]> {
    const source =
      args?.archived === true
        ? this.archived.values()
        : args?.archived === false
          ? this.active.values()
          : [...this.active.values(), ...this.archived.values()];

    return [...source].filter((record) => {
      if (args?.shard && record.shard !== args.shard) {
        return false;
      }

      if (args?.kind && record.kind !== args.kind) {
        return false;
      }

      return true;
    });
  }
}

export class InMemoryVectorStore implements VectorStore {
  private readonly active = new Map<string, number[]>();
  private readonly archived = new Map<string, number[]>();

  async upsert(args: { id: string; embedding: number[]; archived?: boolean }): Promise<void> {
    const target = args.archived ? this.archived : this.active;
    const opposite = args.archived ? this.active : this.archived;
    opposite.delete(args.id);
    target.set(args.id, [...args.embedding]);
  }

  async delete(id: string, archived = false): Promise<void> {
    const target = archived ? this.archived : this.active;
    target.delete(id);
  }

  async search(args: {
    embedding: number[];
    topK: number;
    ids?: string[];
    archived?: boolean;
  }): Promise<Array<{ id: string; score: number }>> {
    const source = args.archived ? this.archived : this.active;
    const allowed = args.ids ? new Set(args.ids) : undefined;

    return [...source.entries()]
      .filter(([id]) => (allowed ? allowed.has(id) : true))
      .map(([id, embedding]) => ({
        id,
        score: cosineSimilarity(args.embedding, embedding),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, args.topK);
  }
}

export class InMemoryGraphStore implements GraphStore {
  private readonly edges = new Map<
    string,
    Array<{
      from: string;
      to: string;
      relation: string;
      meta?: Record<string, unknown>;
    }>
  >();

  async addEdge(args: {
    from: string;
    to: string;
    relation: "supersedes" | "merged-into" | "compressed-into" | "archived-from" | "workflow-step";
    meta?: Record<string, unknown>;
  }): Promise<void> {
    const forward = this.edges.get(args.from) ?? [];
    forward.push({
      from: args.from,
      to: args.to,
      relation: args.relation,
      ...(args.meta ? { meta: args.meta } : {}),
    });
    this.edges.set(args.from, forward);
  }

  async listEdges(id: string): Promise<
    Array<{
      from: string;
      to: string;
      relation: string;
      meta?: Record<string, unknown>;
    }>
  > {
    return this.edges.get(id) ?? [];
  }

  async delete(id: string): Promise<void> {
    this.edges.delete(id);
    for (const [key, value] of this.edges.entries()) {
      const next = value.filter((edge) => edge.from !== id && edge.to !== id);
      if (next.length === 0) {
        this.edges.delete(key);
        continue;
      }
      this.edges.set(key, next);
    }
  }
}
