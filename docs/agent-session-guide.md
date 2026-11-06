# Host-managed agent sessions (POC2)

`atk-agent.v1` separates the agent harness from the model interface. ATK owns the
session, evidence exchange ledger, context versions, limits, validation, and
checkpoints. A model transport such as BXCA produces a correlated JSON reply.
Only a host data provider reads approved sources or metadata.

Inside a Task, call `ctx.runAgent(options)`. ATK supplies the actual workflow ID,
run ID, task name, and workflow cancellation signal. Standalone integrations can
call `runAgentSession({scope, ...options})`. The public types are exported from
the package root.

```ts
const { result, state } = await ctx.runAgent({
  sessionId: `${ctx.runId}-business-analysis`,
  seed: { instructionsVersion: 'analysis.v1', sourceHashes },
  store: new FileAgentSessionStore('./analysis-state'),
  limits: { minRounds: 2, maxRounds: 8, maxRequests: 24 },
  buildContext: state => selectEvidenceWithinBudget(state),
  invoke: (turn, signal) => bxcaModelInterface(turn, signal),
  resolve: (request, signal, state) => approvedReadOnlyProvider(request, signal, state),
  validateResult: (result, state) => validateBusinessAnalysis(result, state),
});
```

## Protocol

Host turns use `analysis_request` or `context_update`. A turn includes
`protocolVersion`, scope IDs, `sessionId`, `turnId`, `round`, `contextVersion`,
selected `context`, the latest data `responses`, and the request ledger.
Model replies repeat `sessionId` and `contextVersion`, and set `inReplyTo` to the
active `turnId`. `parseAgentReply` checks these fields and rejects unknown fields
and unsupported message types. `createAgentReplySchema(turn, resultSchema)` builds
the envelope schema; the application validates the result's domain semantics.

- `need_context`: typed requests with unique `requestId`, `kind`, `selector`, and
  `reason`. Selectors are JSON data, never automatically executed as tools.
- `analysis_result`: a candidate result. ATK returns validation errors to the model
  and requests a review when `minRounds` has not been reached. The Task succeeds
  only after the application validator accepts the final candidate.
- `cannot_complete`: explicit incomplete outcome; it fails the session rather
  than silently generating a replacement answer.

Data responses use `provided`, `not_found`, or `denied`. ATK generates
`already_provided` for a repeated selector. A request ID cannot change its data
selector. Duplicate detection uses canonical JSON, including key ordering, and
applies before the provider is called. Evidence IDs remain application-owned;
model summaries and drafts are never promoted into facts by the harness.

## Limits and checkpoints

Configure total rounds, total/per-round requests, no-progress rounds, total
duration, and byte budgets for turns, replies, data responses, and saved sessions.
The application bounds its full rendered prompt as well; these byte limits do
not claim to be an exact model tokenizer. No transport or provider retry happens
automatically. Cancellation is passed to both callbacks.

`FileAgentSessionStore` writes a SHA-256 protected checkpoint through atomic file
replacement and holds an exclusive session lock while the session runs. A resumed
call must use the same session ID, scope, and canonical seed hash. The seed should
include instructions/schema/settings and evidence versions. Completed data
requests are reused. A saved reply with partly completed lookups resumes those
lookups before calling the model again. Inference interrupted before its response
is checkpointed may run again; providers must be read-only/idempotent.

A process crash can leave a `.lock` file. Inspect its PID and confirm the previous
owner has stopped before removing that one lock file. Locks are never automatically
stolen. Full Cycle-level `durable: true` and resuming an entire workflow remain
outside this session API; session resumption does not imply workflow durability.

## Memory isolation

`beforeStep` and observed Task `memory.retrieve` calls now default to the current
workflow/run scope before ranking and top-K selection. Explicitly global records
without workflow/run IDs can still be included. Direct standalone `retrieve`
remains global unless its new `scope` option is supplied. Similarity writes,
workflow summaries, and repeated-event compression also respect execution scope.
An existing memory ID cannot be overwritten from another execution scope.

## Execution boundary

This protocol does not disable native model-client tools or provide an OS sandbox.
The host must configure a model transport with appropriate execution restrictions.
The harness never executes model-provided SQL, shell commands, or paths by itself.
