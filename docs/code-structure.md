# Code structure and runtime guarantees

The package keeps its existing `index.ts` exports and top-level module paths. Those paths are facades; implementation lives in the directories below.

| Directory | Responsibility |
| --- | --- |
| `src/runtime/` | Registry/run orchestration, task hooks, validation, cancellation, AI monitoring, input bootstrap, result snapshots |
| `src/memory/` | Store adapters, retrieval/context assembly, scoring, record preparation, lifecycle, memory events |
| `src/providers/openai/` | Provider options, HTTP tracing, message mapping, error mapping, streaming queue and client |
| `src/rendering/` | Renderer state, workflow/branch state, formatting, timelines and event reduction |
| `src/rendering/ink/` | Keyboard input, layout, flowcharts, React screen and terminal controller |
| `src/types/` | Domain types; cross-domain references use type-only imports |
| `src/shared/` | Provider-independent abort-signal composition |

## Runtime safety

- `register()` checks workflow names, task hooks/memory metadata, and transition targets. Invalid or unsupported parallel definitions fail before task side effects.
- `run()` and sub-workflow calls require a Map with string keys. Use `createWorkflowInput()` for objects. A requested but unsupported durable run fails explicitly.
- Observer `start()` and `stop()` may return promises. Startup is awaited, every observer receives lifecycle calls even if another fails, and active/global registrations are cleaned up on startup errors.
- `ctx.log` keeps its synchronous API. Async deliveries are tracked; `flush()` waits for them and reports errors instead of leaving rejected promises unhandled.
- A task's `after()` hook still runs after task failure or an invalid result. Aggregate errors retain their nested diagnostics in result snapshots.
- Breaking out of a streaming iterator aborts the HTTP request. `finalResponse` rejects for an aborted partial response; consumers may explicitly await it for error handling.
- Memory writes reuse the embedding response's model identifier. A normal new record needs one embedding call; an explicit vector and model need none.
- Serialization detects cycles in Map, Set, Array and objects, while preserving repeated non-cyclic references.
- Windows Ink terminal shutdown retains the q/Ctrl+C cleanup policy documented in `local-setup.md`.

## Samples and changes

`sample-project/src/sample-runtime.ts` and `sample-files.ts` contain host configuration and output helpers. The Java/JSP workflow keeps its public import path and separates each stage into `java-jsp-modernization/`. The standalone implementation repo does not depend on AXPM source files.

The AXPM repo owns its own shared host helpers and stage modules, plus Web UI tests for live-state races, invalid snapshots and failed requests.

For a runtime change, run typecheck/tests, build all-in-one artifacts, then `test:package` for both `dist` and `.npm-package/dist`. Package verification imports every generated module and checks the public runtime export list in `scripts/public-exports.json`. Intentional API additions must update that fixture explicitly. Windows/Linux CI also executes consumer, issue-lab and local-sample checks.
