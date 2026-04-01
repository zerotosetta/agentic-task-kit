import {
  createCLIRenderer,
  createCycle,
  createWorkflowInput,
  getWorkflowInputValue,
  InMemoryArtifactStore,
  InMemoryMemoryEngine,
  Task,
  type CLIRendererOptions,
  type TaskResult,
  type UserMemory,
  type WorkflowInput,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowMemory
} from "../src/index.js";

type BriefingInput = {
  customerName: string;
  request: string;
  priority: "low" | "medium" | "high";
  constraints: string[];
};

function resolveRendererOptions(): CLIRendererOptions {
  const requestedMode = process.env.CYCLE_RENDER_MODE as CLIRendererOptions["mode"];
  const requestedLogLevel = process.env.CYCLE_LOG_LEVEL as CLIRendererOptions["logLevel"];

  if (requestedMode) {
    return {
      enabled: process.env.CYCLE_LIVE !== "0",
      mode: requestedMode,
      ...(requestedLogLevel ? { logLevel: requestedLogLevel } : {})
    };
  }

  return {
    enabled: process.env.CYCLE_LIVE !== "0",
    ...(requestedLogLevel ? { logLevel: requestedLogLevel } : {})
  };
}

function requireBriefingInput(input: WorkflowInput): BriefingInput {
  const customerName = getWorkflowInputValue<string>(input, "customerName");
  const request = getWorkflowInputValue<string>(input, "request");
  const priority = getWorkflowInputValue<BriefingInput["priority"]>(input, "priority");
  const constraints = getWorkflowInputValue<string[]>(input, "constraints");

  if (!customerName || !request || !priority || !Array.isArray(constraints)) {
    throw new Error("Briefing workflow input is missing required fields.");
  }

  return {
    customerName,
    request,
    priority,
    constraints
  };
}

class CaptureRequestTask extends Task {
  name = "captureRequest";
  memoryPhase = "PLANNING" as const;
  memoryTaskType = "user" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = requireBriefingInput(ctx.input);
    ctx.log.info("Capturing customer request", {
      customerName: input.customerName,
      priority: input.priority
    });

    await ctx.memory.write({
      id: `memory.user.summary.${input.customerName}`,
      shard: "user",
      kind: "summary",
      payload: {
        userId: input.customerName,
        preferences: [...input.constraints],
        behaviorPatterns: [input.priority, input.request],
        lastUpdated: ctx.now()
      } satisfies UserMemory,
      description: "Customer preferences captured for briefing workflow",
      keywords: ["customer", "request", input.priority, "briefing"],
      importance: 0.9,
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      sourceTask: this.name,
      phase: this.memoryPhase,
      taskType: this.memoryTaskType
    });
    ctx.log.success("Stored request context in memory");

    return {
      status: "success",
      output: {
        requestKey: `memory.user.summary.${input.customerName}`
      }
    };
  }
}

class DraftPlanTask extends Task {
  name = "draftPlan";
  memoryPhase = "EXECUTION" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    ctx.log.info("Drafting action plan");
    const input = requireBriefingInput(ctx.input);
    const requestRecord = await ctx.memory.get(`memory.user.summary.${input.customerName}`);
    const request = requestRecord?.payload as UserMemory | undefined;

    if (!request) {
      return {
        status: "fail",
        error: {
          message: "Missing request context in memory."
        }
      };
    }

    const actionPlan = [
      `Restate the request from ${request.userId}.`,
      `Respect constraints: ${request.preferences.join(", ") || "none"}.`,
      request.behaviorPatterns.includes("high")
        ? "Escalate the plan for same-day review."
        : "Queue the plan for normal review."
    ];

    await ctx.memory.write({
      id: `memory.workflow.summary.${ctx.workflowId}.briefing`,
      shard: "workflow",
      kind: "summary",
      payload: {
        workflowId: ctx.workflowId,
        currentStep: this.name,
        history: [],
        contextSummary: actionPlan.join(" ")
      } satisfies WorkflowMemory,
      description: "Workflow briefing summary",
      keywords: ["workflow", "briefing", "plan"],
      importance: 0.88,
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      sourceTask: this.name,
      phase: this.memoryPhase,
      taskType: this.memoryTaskType
    });

    const artifact = await ctx.artifacts.create({
      name: "briefing-plan.json",
      mimeType: "application/json",
      bytes: new TextEncoder().encode(
        JSON.stringify(
          {
            workflowId: ctx.workflowId,
            customerName: request.userId,
            priority: input.priority,
            actionPlan,
            assembledContext: ctx.memoryContext?.assembledContext ?? ""
          },
          null,
          2
        )
      ),
      meta: {
        task: this.name
      }
    });

    ctx.log.success("Created briefing plan artifact", {
      artifactId: artifact.artifactId,
      steps: actionPlan.length
    });

    return {
      status: "success",
      output: {
        artifactId: artifact.artifactId,
        actionPlan
      }
    };
  }
}

const ConsumerWorkflow: WorkflowDefinition = {
  name: "customer-briefing",
  start: "captureRequest",
  end: "end",
  tasks: {
    captureRequest: new CaptureRequestTask(),
    draftPlan: new DraftPlanTask()
  },
  transitions: {
    captureRequest: {
      success: "draftPlan",
      fail: "end"
    },
    draftPlan: {
      success: "end",
      fail: "end"
    }
  }
};

const memoryEngine = new InMemoryMemoryEngine();
const artifactStore = new InMemoryArtifactStore();
const renderer = createCLIRenderer(resolveRendererOptions());
const cycle = createCycle({
  memoryEngine,
  artifactStore,
  observers: [renderer]
});

cycle.register("customer-briefing", ConsumerWorkflow);

const input = createWorkflowInput({
  customerName: "Skyend Retail",
  request: "Create a rollout briefing for the first AX Workflow MVP pilot.",
  priority: "high",
  constraints: ["Keep the first release sequential only", "Show CLI line mode output"]
});

const { frame } = await cycle.run("customer-briefing", input, {
  rag: [
    {
      id: "policy",
      text: "The first release should prioritize observable sequential execution over advanced orchestration."
    }
  ]
});

const artifacts = await artifactStore.list();
const latestArtifact = artifacts[artifacts.length - 1];

process.stdout.write(
  `Consumer example finished with status=${frame.status} artifact=${latestArtifact?.uri ?? "none"}\n`
);
