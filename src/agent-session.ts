import { createHash, randomUUID } from "node:crypto";
import { InMemoryAgentSessionStore } from "./agent-session-store.js";
import { combineAbortSignals } from "./shared/abort.js";
import { AGENT_PROTOCOL_VERSION } from "./types/agent.js";
import type { AgentDataRequest, AgentDataResponse, AgentJSON, AgentReply, AgentSessionLimits, AgentSessionOptions, AgentSessionState, AgentTurn } from "./types/agent.js";

export { AGENT_PROTOCOL_VERSION } from "./types/agent.js";
export class AgentSessionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "AgentSessionError"; }
}
const fail = (code: string, message: string): never => { throw new AgentSessionError(code, message); };
const defaults = { minRounds: 1, maxRounds: 8, maxRequests: 24, maxRequestsPerRound: 4, maxNoProgressRounds: 2,
  maxInputBytes: 1_000_000, maxResponseBytes: 512_000, maxDataBytes: 128_000, maxSessionBytes: 16_000_000, timeoutMs: 600_000 };
export function resolveAgentSessionLimits(value: AgentSessionLimits = {}): Required<AgentSessionLimits> {
  const result = { ...defaults, ...value };
  for (const [key, item] of Object.entries(result)) {
    if (!(key in defaults) || !Number.isSafeInteger(item) || item < 1 || item > 2_147_483_647)
      fail("AGENT_CONFIG", `Invalid agent session limit: ${key}.`);
  }
  if (result.minRounds > result.maxRounds) fail("AGENT_CONFIG", "minRounds exceeds maxRounds.");
  return result;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("AGENT_PROTOCOL", "Expected a JSON object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, limit = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0"))
    return fail("AGENT_PROTOCOL", `Invalid ${name}.`);
  return value;
}
function assertJSON(value: unknown): asserts value is AgentJSON {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(assertJSON); return; }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    Object.values(value).forEach(assertJSON); return;
  }
  fail("AGENT_PROTOCOL", "Value is not JSON data.");
}
function canonical(value: unknown): string {
  assertJSON(value);
  const ordered = (item: AgentJSON): AgentJSON => Array.isArray(item) ? item.map(ordered)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key]!)])) : item;
  return JSON.stringify(ordered(value));
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

export function parseAgentReply(value: unknown, turn: AgentTurn): AgentReply {
  const reply = object(typeof value === "string" ? JSON.parse(value) : value);
  assertJSON(reply);
  const common = ["protocolVersion", "type", "sessionId", "inReplyTo", "contextVersion", "summary"];
  const fields = reply.type === "need_context" ? ["requests"] : reply.type === "analysis_result" ? ["result"] : reply.type === "cannot_complete" ? ["reason"] : [];
  if (!fields.length || Object.keys(reply).some(key => ![...common, ...fields].includes(key))) fail("AGENT_PROTOCOL", "Unsupported response type or fields.");
  if (reply.protocolVersion !== AGENT_PROTOCOL_VERSION || reply.sessionId !== turn.sessionId || reply.inReplyTo !== turn.turnId || reply.contextVersion !== turn.contextVersion)
    fail("AGENT_CORRELATION", "Response does not match the active session, turn and context version.");
  if (reply.summary !== undefined) text(reply.summary, "summary", 4000);
  if (reply.type === "need_context") {
    if (!Array.isArray(reply.requests) || !reply.requests.length) fail("AGENT_PROTOCOL", "need_context requires requests.");
    const ids = new Set<string>();
    for (const item of reply.requests as unknown[]) {
      const request = object(item);
      if (Object.keys(request).some(key => !["requestId", "kind", "selector", "reason"].includes(key))) fail("AGENT_PROTOCOL", "Unsupported request fields.");
      const id = text(request.requestId, "requestId", 128);
      if (ids.has(id)) fail("AGENT_PROTOCOL", "Duplicate requestId in a turn.");
      ids.add(id);
      text(request.kind, "request kind", 80); text(request.reason, "request reason", 1000); object(request.selector);
      if (bytes(request.selector) > 4000) fail("AGENT_PROTOCOL", "Request selector is too large.");
    }
  } else if (reply.type === "analysis_result") {
    if (!("result" in reply)) fail("AGENT_PROTOCOL", "analysis_result requires result.");
  } else text(reply.reason, "cannot_complete reason", 4000);
  return reply as AgentReply;
}

/** A schema for the model envelope; resultSchema is supplied by the application. */
export function createAgentReplySchema(turn: Pick<AgentTurn, "sessionId" | "turnId" | "contextVersion">, resultSchema: unknown): Record<string, unknown> {
  const base = { protocolVersion: { const: AGENT_PROTOCOL_VERSION }, sessionId: { const: turn.sessionId }, inReplyTo: { const: turn.turnId }, contextVersion: { const: turn.contextVersion }, summary: { type: "string", maxLength: 4000 } };
  const branch = (type: string, properties: Record<string, unknown>) => ({ type: "object", properties: { ...base, type: { const: type }, ...properties },
    required: ["protocolVersion", "type", "sessionId", "inReplyTo", "contextVersion", ...Object.keys(properties)], additionalProperties: false });
  return { oneOf: [branch("need_context", { requests: { type: "array", minItems: 1, items: { type: "object", properties: {
    requestId: { type: "string" }, kind: { type: "string" }, selector: { type: "object" }, reason: { type: "string" } }, required: ["requestId", "kind", "selector", "reason"], additionalProperties: false } } }),
    branch("analysis_result", { result: resultSchema }), branch("cannot_complete", { reason: { type: "string", minLength: 1 } })] };
}

export async function runAgentSession<Result>(options: AgentSessionOptions<Result>): Promise<{ result: Result; state: AgentSessionState }> {
  const limits = resolveAgentSessionLimits(options.limits);
  assertJSON(options.seed);
  for (const [key, value] of Object.entries(options.scope)) text(value, key);
  const sessionId = options.sessionId ?? randomUUID();
  const store = options.store ?? new InMemoryAgentSessionStore();
  const signal = combineAbortSignals([options.signal, AbortSignal.timeout(limits.timeoutMs)])!;
  return store.withLock(sessionId, async () => {
    signal.throwIfAborted();
    let state = await store.load(sessionId);
    const seedHash = digest(options.seed);
    if (state && (state.protocolVersion !== AGENT_PROTOCOL_VERSION || state.seedHash !== seedHash || state.workflowId !== options.scope.workflowId || state.runId !== options.scope.runId || state.taskId !== options.scope.taskId))
      fail("AGENT_RESUME_SCOPE", "Checkpoint belongs to different inputs or execution scope.");
    state ??= { ...options.scope, protocolVersion: AGENT_PROTOCOL_VERSION, sessionId, seedHash, revision: 0, contextVersion: 1,
      status: "running", rounds: [], exchanges: [], latestResponses: [], noProgressRounds: 0 };
    const checkpoint = async () => {
      if (bytes(state) > limits.maxSessionBytes) fail("AGENT_SESSION_LIMIT", "Session checkpoint exceeds its byte limit.");
      state.revision += 1;
      await store.save(state);
      await options.onCheckpoint?.(structuredClone(state));
    };
    const stop = async (code: string, message: string): Promise<never> => {
      state.status = "incomplete"; state.feedback = { code, message }; await checkpoint(); return fail(code, message);
    };
    if (state.status === "complete") return { result: await options.validateResult(state.result!, state), state };
    if (state.status === "incomplete") return fail(state.feedback?.code ?? "AGENT_INCOMPLETE", state.feedback?.message ?? "Session is incomplete.");
    while (true) {
      signal.throwIfAborted();
      let round = state.rounds.at(-1);
      // A received reply is resumed before any new model invocation.
      if (round && round.turn.contextVersion !== state.contextVersion) round = undefined;
      if (!round) {
        if (state.rounds.length >= limits.maxRounds) return stop("AGENT_ROUND_LIMIT", "Analysis exceeded its model round limit.");
        const turn: AgentTurn = { ...options.scope, protocolVersion: AGENT_PROTOCOL_VERSION, type: state.rounds.length ? "context_update" : "analysis_request",
          sessionId, turnId: randomUUID(), round: state.rounds.length + 1, contextVersion: state.contextVersion,
          context: await options.buildContext(structuredClone(state)), responses: state.latestResponses,
          requestLedger: state.exchanges.map(item => ({ requestId: item.request.requestId, kind: item.request.kind, selector: item.request.selector, status: item.response.status, evidenceIds: item.response.evidenceIds })),
          ...(state.feedback ? { feedback: state.feedback } : {}), ...(state.draft !== undefined ? { draft: state.draft } : {}) };
        assertJSON(turn);
        if (bytes(turn) > limits.maxInputBytes) return stop("AGENT_INPUT_LIMIT", "Model input exceeds its byte limit; narrow the evidence selection.");
        round = { turn }; state.rounds.push(round); await checkpoint();
      }
      if (!round.reply) {
        const raw = await options.invoke(structuredClone(round.turn), signal);
        signal.throwIfAborted();
        if ((typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : bytes(raw)) > limits.maxResponseBytes) return stop("AGENT_RESPONSE_LIMIT", "Model response exceeds its byte limit.");
        round.reply = parseAgentReply(raw, round.turn); await checkpoint();
      }
      const reply = round.reply;
      if (reply.type === "cannot_complete") return stop("AGENT_INCOMPLETE", reply.reason);
      if (reply.type === "analysis_result") {
        if (round.turn.round < limits.minRounds) {
          state.draft = reply.result;
          state.feedback = { code: "REVIEW_REQUIRED", message: "Review the draft against the supplied evidence, resolve gaps through need_context, then return the final analysis_result." };
        } else {
          let validated: Result;
          try { validated = await options.validateResult(reply.result, structuredClone(state)); }
          catch (error) {
            round.validationError = { code: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "RESULT_VALIDATION", message: String(error instanceof Error ? error.message : error).slice(0, 2000) };
            state.draft = reply.result;
            state.feedback = { code: "RESULT_VALIDATION", message: String(error instanceof Error ? error.message : error).slice(0, 2000) };
            state.contextVersion += 1; state.latestResponses = []; await checkpoint(); continue;
          }
          state.result = reply.result; state.status = "complete"; delete state.draft; await checkpoint();
          return { result: validated, state };
        }
        state.latestResponses = []; state.contextVersion += 1; await checkpoint(); continue;
      }
      if (reply.requests.length > limits.maxRequestsPerRound) return stop("AGENT_REQUEST_LIMIT", "Too many requests in a model round.");
      const requestCount = state.rounds.reduce((sum, item) => sum + (item.reply?.type === "need_context" ? item.reply.requests.length : 0), 0);
      if (requestCount > limits.maxRequests) return stop("AGENT_REQUEST_LIMIT", "Analysis exceeded its data request limit.");
      const responses: AgentDataResponse[] = [];
      let progress = false;
      for (const request of reply.requests) {
        signal.throwIfAborted();
        const fingerprint = digest({ kind: request.kind, selector: request.selector });
        const sameId = state.exchanges.find(item => item.request.requestId === request.requestId);
        if (sameId && sameId.fingerprint !== fingerprint) return stop("AGENT_REQUEST_ID", "A requestId was reused for different data.");
        if (sameId) {
          if (sameId.turnId === round.turn.turnId) { responses.push(sameId.response); progress ||= sameId.response.status === "provided"; }
          else responses.push({ requestId: request.requestId, status: "already_provided", evidenceIds: sameId.response.evidenceIds, message: `Request already resolved (${sameId.response.status}).` });
          continue;
        }
        const prior = state.exchanges.find(item => item.fingerprint === fingerprint);
        let response: AgentDataResponse;
        if (prior) response = { requestId: request.requestId, status: "already_provided", evidenceIds: prior.response.evidenceIds, message: `See request ${prior.request.requestId} (${prior.response.status}).` };
        else {
          response = await options.resolve(structuredClone(request), signal, structuredClone(state));
          signal.throwIfAborted();
          assertJSON(response);
          if (response.requestId !== request.requestId || !["provided", "not_found", "denied"].includes(response.status) || !Array.isArray(response.evidenceIds) || response.evidenceIds.some(id => typeof id !== "string"))
            return stop("AGENT_DATA_PROTOCOL", "Invalid host data response.");
          if (bytes(response) > limits.maxDataBytes) response = { requestId: request.requestId, status: "denied", evidenceIds: [], message: "Requested data exceeds its byte limit. Request a narrower range." };
        }
        progress ||= response.status === "provided";
        state.exchanges.push({ turnId: round.turn.turnId, request, fingerprint, response }); responses.push(response); await checkpoint();
      }
      state.latestResponses = responses; state.contextVersion += 1; delete state.feedback;
      state.noProgressRounds = progress ? 0 : state.noProgressRounds + 1;
      await checkpoint();
      if (state.noProgressRounds >= limits.maxNoProgressRounds) return stop("AGENT_NO_PROGRESS", "Repeated requests produced no new evidence.");
    }
  });
}
