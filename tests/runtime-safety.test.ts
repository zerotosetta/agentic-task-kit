import { describe, expect, it, vi } from "vitest";
import {
  createCycle,
  createTaskLogger,
  createWorkflowInput,
  ExecutionBroadcaster,
  getGlobalWorkflowRuntimeController,
  toSerializableValue,
  type ExecutionObserver,
  type TaskLike,
  type TaskResult,
  type WorkflowDefinition,
  type WorkflowInput,
} from "../src/index.js";

function workflow(task: Partial<TaskLike> = {}): WorkflowDefinition {
  return {
    name: "safety",
    start: "step",
    tasks: {
      step: {
        name: "step",
        memoryPhase: "EXECUTION",
        memoryTaskType: "workflow",
        run: async () => ({ status: "success" }),
        ...task,
      },
    },
    transitions: { step: "end" },
  };
}

describe("Runtime safety", () => {
  it("preserves nested aggregate failure details in the run snapshot", async () => {
    const cycle = createCycle();
    cycle.register(
      "valid",
      workflow({
        run: async () => {
          throw new AggregateError([new Error("first"), new Error("second")], "batch failed");
        },
      }),
    );
    const result = await cycle.run("valid", createWorkflowInput());
    expect(result.frame.taskResults.step?.error?.details).toMatchObject({
      errors: [{ message: "first" }, { message: "second" }],
    });
  });
  it("rejects invalid task/transition definitions before executing work", () => {
    const cycle = createCycle();
    const definition = workflow();
    definition.transitions.step = "missing";
    expect(() => cycle.register("bad", definition)).toThrow('unknown state "missing"');
    const invalid = workflow();
    invalid.tasks.step!.memoryPhase = "invalid" as TaskLike["memoryPhase"];
    expect(() => cycle.register("bad", invalid)).toThrow("memory metadata");
  });

  it("validates Map inputs and refuses a durability guarantee it cannot provide", async () => {
    const cycle = createCycle();
    cycle.register("valid", workflow());
    await expect(cycle.run("valid", {} as WorkflowInput)).rejects.toThrow("Map with string keys");
    await expect(
      cycle.run("valid", new Map([[1, "value"]]) as unknown as WorkflowInput),
    ).rejects.toThrow("Map with string keys");
    await expect(cycle.run("valid", createWorkflowInput(), { durable: true })).rejects.toThrow(
      "Durable execution is not implemented",
    );
    expect(cycle.hasActiveRuns()).toBe(false);
  });

  it("awaits observer startup and cleanup around task execution", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observer: ExecutionObserver = {
      onEvent() {},
      async start() {
        await gate;
        calls.push("start");
      },
      async stop() {
        await Promise.resolve();
        calls.push("stop");
      },
    };
    const cycle = createCycle({ observers: [observer] });
    cycle.register(
      "valid",
      workflow({
        run: async () => {
          calls.push("task");
          return { status: "success" };
        },
      }),
    );
    const run = cycle.run("valid", createWorkflowInput());
    expect(calls).toEqual([]);
    release();
    expect((await run).frame.status).toBe("success");
    expect(calls).toEqual(["start", "task", "stop"]);
  });

  it("cleans active/global registrations even when startup and cleanup both fail", async () => {
    const startup = new Error("startup failed");
    const cleanup = new Error("cleanup failed");
    const stop = vi.fn(async () => {
      throw cleanup;
    });
    const cycle = createCycle({
      observers: [
        {
          onEvent() {},
          async start() {
            throw startup;
          },
          stop,
        },
      ],
    });
    cycle.register("valid", workflow());
    await expect(cycle.run("valid", createWorkflowInput())).rejects.toMatchObject({
      errors: [startup, cleanup],
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(cycle.hasActiveRuns()).toBe(false);
    expect(getGlobalWorkflowRuntimeController().hasActiveRuns()).toBe(false);
  });

  it("turns malformed task results into actionable failures and still invokes after", async () => {
    const after = vi.fn<NonNullable<TaskLike["after"]>>(async () => undefined);
    const cycle = createCycle();
    cycle.register("valid", workflow({ run: async () => null as unknown as TaskResult, after }));
    const result = await cycle.run("valid", createWorkflowInput());
    expect(result.frame.status).toBe("fail");
    expect(result.frame.errors[0]).toContain("must return a TaskResult");
    expect(after.mock.calls[0]?.[1]).toMatchObject({ status: "fail" });
  });
});

describe("Observer delivery", () => {
  it("delivers to every observer even when one throws synchronously", async () => {
    const failure = new Error("observer failed");
    const received = vi.fn();
    const broadcaster = new ExecutionBroadcaster([
      {
        onEvent() {
          throw failure;
        },
      },
      { onEvent: received },
    ]);
    await expect(
      broadcaster.emit({
        type: "workflow.started",
        timestamp: 1,
        workflowId: "wf",
        runId: "run",
        summary: "start",
      }),
    ).rejects.toBe(failure);
    expect(received).toHaveBeenCalledOnce();
  });

  it("flushes delayed task log deliveries and surfaces logger failures without unhandled rejections", async () => {
    const failure = new Error("log sink unavailable");
    const finished: string[] = [];
    const broadcaster = new ExecutionBroadcaster([
      {
        async onEvent() {
          await new Promise((resolve) => setTimeout(resolve, 5));
          finished.push("event");
        },
        async onTaskLog() {
          throw failure;
        },
      },
    ]);
    const log = createTaskLogger({ broadcaster, workflowId: "wf", runId: "run", now: () => 1 });
    log.info("message");
    await expect(broadcaster.flush()).rejects.toBe(failure);
    expect(finished).toEqual(["event"]);
    await expect(broadcaster.stop()).resolves.toBeUndefined();
  });
});

describe("Input serialization", () => {
  it("handles cycles in Map, Set and Array without stack overflow", () => {
    const map = new Map<string, unknown>();
    map.set("self", map);
    const set = new Set<unknown>();
    set.add(set);
    const array: unknown[] = [];
    array.push(array);
    expect(toSerializableValue(map)).toEqual({ self: "[Circular]" });
    expect(toSerializableValue(set)).toEqual(["[Circular]"]);
    expect(toSerializableValue(array)).toEqual(["[Circular]"]);
  });
  it("preserves repeated shared values that are not cycles", () => {
    const shared = { count: 1 };
    expect(toSerializableValue([shared, shared])).toEqual([{ count: 1 }, { count: 1 }]);
  });
});
