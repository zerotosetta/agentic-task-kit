import type {
  ExecutionEvent,
  HybridSearchHit,
  HybridSearchParams,
  MemoryPiece,
  MemoryScope,
  MemoryStore
} from "./types.js";
import { ExecutionBroadcaster } from "./events.js";

type MemoryStoreEventType = "memory.put" | "memory.delete" | "retrieval.performed";
type MemoryStoreEvent = {
  type: MemoryStoreEventType;
  timestamp: number;
  workflowId: string;
  runId: string;
  summary: string;
  meta?: Record<string, unknown>;
};

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}

function computeKeywordScore(piece: MemoryPiece, queryTokens: string[]): number {
  const haystack = [
    piece.key,
    piece.description,
    piece.keywords.join(" "),
    JSON.stringify(piece.value)
  ]
    .join(" ")
    .toLowerCase();

  return queryTokens.reduce((score, token) => {
    return haystack.includes(token) ? score + 1 : score;
  }, 0);
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly pieces = new Map<string, MemoryPiece>();

  async put(piece: MemoryPiece): Promise<void> {
    this.pieces.set(piece.key, { ...piece });
  }

  async get(key: string): Promise<MemoryPiece | null> {
    return this.pieces.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.pieces.delete(key);
  }

  async hybridSearch(
    query: string,
    params: HybridSearchParams
  ): Promise<HybridSearchHit[]> {
    const queryTokens = tokenize(query);
    const now = Date.now();

    const hits = [...this.pieces.values()]
      .map((piece) => {
        const keywordScore = computeKeywordScore(piece, queryTokens);
        const vectorScore = piece.embedding ? 0.1 : 0;
        const recencyBoost =
          params.recencyGamma && piece.updatedAt
            ? params.recencyGamma *
              Math.max(0, 1 - Math.min(1, (now - piece.updatedAt) / (7 * 24 * 60 * 60 * 1000)))
            : 0;
        const importanceBoost = (params.importanceDelta ?? 0) * piece.importance;
        const finalScore =
          keywordScore * params.alpha + vectorScore * params.beta + recencyBoost + importanceBoost;

        return {
          piece,
          keywordScore,
          vectorScore,
          finalScore
        };
      })
      .filter((hit) => hit.finalScore > 0)
      .sort((left, right) => right.finalScore - left.finalScore)
      .slice(0, params.topK);

    return hits;
  }

  async listByScope(scope: MemoryScope): Promise<MemoryPiece[]> {
    return [...this.pieces.values()].filter((piece) => piece.scope === scope);
  }
}

type ObservedMemoryStoreArgs = {
  store: MemoryStore;
  broadcaster: ExecutionBroadcaster;
  workflowId: string;
  runId: string;
  now: () => number;
};

export function createObservedMemoryStore(args: ObservedMemoryStoreArgs): MemoryStore {
  const emit = async (
    type: MemoryStoreEventType,
    summary: string,
    meta?: Record<string, unknown>
  ): Promise<void> => {
    const event: MemoryStoreEvent = {
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
    async put(piece) {
      await args.store.put(piece);
      await emit("memory.put", `memory put ${piece.key}`, {
        key: piece.key,
        scope: piece.scope,
        category: piece.category
      });
    },
    async get(key) {
      return args.store.get(key);
    },
    async delete(key) {
      await args.store.delete(key);
      await emit("memory.delete", `memory delete ${key}`, { key });
    },
    async hybridSearch(query, params) {
      const hits = await args.store.hybridSearch(query, params);
      await emit("retrieval.performed", `retrieval performed for "${query}"`, {
        hitCount: hits.length,
        topK: params.topK
      });
      return hits;
    },
    async listByScope(scope) {
      return args.store.listByScope(scope);
    }
  };
}
