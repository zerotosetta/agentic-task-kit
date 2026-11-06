/** Host-managed dialogue. Model messages request data; the host owns all execution. */
export type AgentJSON = null | boolean | number | string | AgentJSON[] | { [key: string]: AgentJSON };
export const AGENT_PROTOCOL_VERSION = "atk-agent.v1" as const;
export type AgentScope = { workflowId: string; runId: string; taskId: string };
export type AgentDataRequest = {
  requestId: string;
  kind: string;
  selector: { [key: string]: AgentJSON };
  reason: string;
};
export type AgentDataResponse = {
  requestId: string;
  status: "provided" | "not_found" | "denied" | "already_provided";
  evidenceIds: string[];
  message?: string;
  data?: AgentJSON;
};
export type AgentReply = {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  sessionId: string;
  inReplyTo: string;
  contextVersion: number;
  summary?: string;
} & (
  | { type: "need_context"; requests: AgentDataRequest[] }
  | { type: "analysis_result"; result: AgentJSON }
  | { type: "cannot_complete"; reason: string }
);
export type AgentTurn = AgentScope & {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  type: "analysis_request" | "context_update";
  sessionId: string;
  turnId: string;
  round: number;
  contextVersion: number;
  context: AgentJSON;
  responses: AgentDataResponse[];
  requestLedger: Array<{ requestId: string; kind: string; selector: AgentDataRequest["selector"]; status: AgentDataResponse["status"]; evidenceIds: string[] }>;
  feedback?: { code: string; message: string };
  draft?: AgentJSON;
};
export type AgentExchange = { turnId: string; request: AgentDataRequest; fingerprint: string; response: AgentDataResponse };
export type AgentRound = { turn: AgentTurn; reply?: AgentReply; validationError?: { code: string; message: string } };
export type AgentSessionState = AgentScope & {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  sessionId: string;
  seedHash: string;
  revision: number;
  contextVersion: number;
  status: "running" | "complete" | "incomplete";
  rounds: AgentRound[];
  exchanges: AgentExchange[];
  latestResponses: AgentDataResponse[];
  noProgressRounds: number;
  feedback?: { code: string; message: string };
  draft?: AgentJSON;
  result?: AgentJSON;
};
export interface AgentSessionStore {
  load(sessionId: string): Promise<AgentSessionState | null>;
  save(state: AgentSessionState): Promise<void>;
  /** One owner per session, including model and data-provider calls. */
  withLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
}
export type AgentSessionLimits = {
  minRounds?: number;
  maxRounds?: number;
  maxRequests?: number;
  maxRequestsPerRound?: number;
  maxNoProgressRounds?: number;
  maxInputBytes?: number;
  maxResponseBytes?: number;
  maxDataBytes?: number;
  maxSessionBytes?: number;
  timeoutMs?: number;
};
export type AgentSessionOptions<Result> = {
  scope: AgentScope;
  sessionId?: string;
  /** Includes task instructions, schema and evidence hashes; binds resumptions to the same inputs. */
  seed: AgentJSON;
  store?: AgentSessionStore;
  signal?: AbortSignal;
  limits?: AgentSessionLimits;
  buildContext(state: Readonly<AgentSessionState>): AgentJSON | Promise<AgentJSON>;
  invoke(turn: AgentTurn, signal: AbortSignal): Promise<unknown>;
  resolve(request: AgentDataRequest, signal: AbortSignal, state: Readonly<AgentSessionState>): Promise<AgentDataResponse>;
  validateResult(value: AgentJSON, state: Readonly<AgentSessionState>): Result | Promise<Result>;
  onCheckpoint?(state: Readonly<AgentSessionState>): void | Promise<void>;
};
