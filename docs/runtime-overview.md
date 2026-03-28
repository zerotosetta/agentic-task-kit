# Runtime Overview

## Foundation MVP
- `createCycle()` creates a registry-backed runtime.
- `register(key, workflow)` registers a workflow definition.
- `run(key, input, options)` executes sequential tasks and returns an `ExecutionFrame`.

## Included runtime pieces
- sequential task execution
- workflow/task execution events
- structured task log channel via `ctx.log`
- in-memory memory and artifact stores
- CLI renderer with:
  - `compact`
  - `line`
  - `jsonl`
  - `plain`
  - `enabled=false` fallback to line output

## Current limitation
- parallel transition is typed but not implemented in the Foundation MVP
- durable execution is not implemented
- hybrid retrieval currently uses lightweight lexical-first scoring
