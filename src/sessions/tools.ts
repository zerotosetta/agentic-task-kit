import { isRecord } from "../durable-validation.js";
import { McpWorkflowError, type McpConfig } from "../mcp/config.js";
import { McpWorkflowService } from "../mcp/service.js";
import { workflowTools } from "../mcp/stdio.js";
import type { PipelineValue } from "../pipeline-authoring.js";
import { assertPipelineValue, type PipelineSchema } from "../pipeline-schema.js";
import { SessionStore } from "./store.js";

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const sessionId = str;

function object<const P extends Record<string, PipelineSchema>, const K extends readonly (keyof P & string)[]>(
  properties: P, required: K,
) {
  return { type: "object", properties, required, additionalProperties: false } as const;
}

function method<const S extends PipelineSchema>(
  name: string, description: string, inputSchema: S, readOnlyHint: boolean, handler: (args: PipelineValue<S>) => unknown,
) {
  return {
    descriptor: { name, description, inputSchema, annotations: { readOnlyHint } },
    invoke(args: Record<string, unknown>) {
      try { assertPipelineValue(inputSchema, args, "Tool arguments"); }
      catch (error) { throw new McpWorkflowError("INVALID_ARGUMENT", error instanceof Error ? error.message : "Invalid arguments."); }
      return handler(args as PipelineValue<S>);
    },
  };
}

const discovery = new Set(["workflow_list", "workflow_describe"]);
const remoteWorkflows = workflowTools.map(tool => discovery.has(tool.name) ? tool : {
  ...tool,
  inputSchema: {
    ...tool.inputSchema,
    properties: { sessionId, ...tool.inputSchema.properties },
    required: ["sessionId", ...tool.inputSchema.required],
  },
});

function withSessionAction<T>(result: T, id: string, inputSha?: string | null): T {
  if (!isRecord(result) || !isRecord(result.nextAction) || !isRecord(result.nextAction.arguments)) return result;
  const next = result.nextAction;
  const args = { ...result.nextAction.arguments, sessionId: id };
  const sha = inputSha ?? result.inputSha256;
  return { ...result, nextAction: { ...next, arguments: {
    ...args, ...(next.action === "resume" && typeof sha === "string" && { expectedInputSha256: sha }),
  } } };
}

/** A service instance represents one shared workspace and only exposes runs started in its sessions. */
export class SessionTools {
  private readonly sessions: SessionStore;
  private readonly workflows: McpWorkflowService;
  private readonly methods: ReturnType<typeof method>[];

  constructor(config: McpConfig, workerEntry: string) {
    this.sessions = new SessionStore(config.stateDirectory);
    try { this.workflows = new McpWorkflowService(config, workerEntry); }
    catch (error) { this.sessions.close(); throw error; }
    this.methods = [
      method("session_create", "Create a persistent work session. Retry a lost response with the same idempotencyKey, title and goal.",
        object({ title: str, goal: str, idempotencyKey: str }, ["title", "goal", "idempotencyKey"]), false, args => this.sessions.create(args)),
      method("session_list", "Find sessions by title, goal or exact ID, including the current workflow progress.",
        object({ query: str, limit: int, offset: int }, []), true, async ({ query, limit = 25, offset = 0 }) => {
          if (limit < 1 || limit > 100) throw new McpWorkflowError("INVALID_ARGUMENT", "limit must be between 1 and 100.");
          const rows = this.sessions.list({ ...(query !== undefined && { query }), limit: limit + 1, offset });
          const page = rows.slice(0, limit);
          const sessions = await Promise.all(page.map(async entry => {
            const { progress, run } = await this.workflows.sessionView(entry.sessionId);
            return { ...entry, status: withSessionAction(progress, entry.sessionId, run?.inputSha256) };
          }));
          return { sessions, nextOffset: rows.length > limit ? offset + limit : null };
        }),
      method("session_context", "Recover the goal, handoff, files, active run, next action and final artifacts. completedStages includes historical commits across reruns and input generations. Use run and progress for current execution.",
        object({ sessionId }, ["sessionId"]), true, async args => {
          const session = this.sessions.get(args.sessionId);
          const view = await this.workflows.sessionView(session.sessionId, true);
          const { run, progress } = view;
          const allowedActions = ["session_note", "workspace_write", "workspace_read"];
          if (run) {
            allowedActions.push("workflow_results", "workflow_progress");
            if (run.nextAction.action === "resume") allowedActions.push("workflow_resume");
            if (run.status === "queued" || run.status === "running") allowedActions.push("workflow_cancel");
            else if (run.checkpointSeq !== null && run.nextAction.action !== "status") allowedActions.push("workflow_rerun");
          } else allowedActions.push("workflow_start");
          return { session, ...view, run: withSessionAction(run, session.sessionId),
            progress: withSessionAction(progress, session.sessionId, run?.inputSha256), files: this.sessions.listFiles(args.sessionId), allowedActions };
        }),
      method("session_note", "Save a handoff summary and next action against the last observed note version.",
        object({ sessionId, expectedVersion: int, summary: str, nextAction: str }, ["sessionId", "expectedVersion", "summary", "nextAction"]),
        false, args => this.sessions.note(args)),
      method("workspace_list", "List the current version, size and SHA-256 of each saved text file.",
        object({ sessionId }, ["sessionId"]), true, args => ({ files: this.sessions.listFiles(args.sessionId) })),
      method("workspace_read", "Read a saved UTF-8 file, optionally at an earlier version.",
        object({ sessionId, path: str, version: int }, ["sessionId", "path"]), true, args => this.sessions.readFile(args)),
      method("workspace_write", "Save UTF-8 text. Use expectedVersion 0 to create, or the version read to update.",
        object({ sessionId, path: str, expectedVersion: int, content: str }, ["sessionId", "path", "expectedVersion", "content"]),
        false, args => this.sessions.writeFile(args)),
    ];
  }

  listTools(): readonly { name: string; description: string; inputSchema: object }[] {
    return [...this.methods.map(operation => operation.descriptor), ...remoteWorkflows];
  }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const operation = this.methods.find(entry => entry.descriptor.name === name);
    if (operation) return operation.invoke(args);
    if (!remoteWorkflows.some(entry => entry.name === name)) throw new McpWorkflowError("UNKNOWN_TOOL", "Unknown tool.");
    if (discovery.has(name)) return this.workflows.call(name, args, signal);
    const { sessionId: id, ...input } = args;
    if (typeof id !== "string") throw new McpWorkflowError("INVALID_ARGUMENT", "sessionId is required.");
    this.sessions.get(id);
    if (name === "workflow_progress") {
      const { run, progress } = await this.workflows.sessionView(id);
      if (!run || run.runId !== input.runId) throw new McpWorkflowError("RUN_NOT_FOUND", "Run not found in this session.");
      if (Object.keys(input).some(key => key !== "runId")) throw new McpWorkflowError("INVALID_ARGUMENT", "Unexpected tool argument.");
      return withSessionAction(progress, id, run.inputSha256);
    }
    const result = await this.workflows.callForSession(id, name, input, signal);
    return withSessionAction(result, id);
  }

  close() {
    try { this.workflows.close(); } finally { this.sessions.close(); }
  }
}
