import {
  createCLIRenderer,
  createCycle,
  InMemoryArtifactStore,
  InMemoryMemoryStore,
  Task,
  type CLIRendererOptions,
  type MemoryPiece,
  type TaskResult,
  type WorkflowContext,
  type WorkflowDefinition
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

class CaptureRequestTask extends Task {
  name = "captureRequest";

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = ctx.input as BriefingInput;
    ctx.log.info("Capturing customer request", {
      customerName: input.customerName,
      priority: input.priority
    });

    const requestPiece: MemoryPiece = {
      key: `workflow.${ctx.workflowId}.request`,
      scope: "workflow",
      category: "context",
      description: "Incoming customer request for the workflow",
      keywords: ["customer", "request", input.priority],
      value: input,
      importance: 0.9,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
      sourceTask: this.name
    };

    await ctx.memory.put(requestPiece);
    ctx.log.success("Stored request context in memory");

    return {
      status: "success",
      output: {
        requestKey: requestPiece.key
      }
    };
  }
}

class DraftPlanTask extends Task {
  name = "draftPlan";

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    ctx.log.info("Drafting action plan");
    const requestPiece = await ctx.memory.get(`workflow.${ctx.workflowId}.request`);
    const request = requestPiece?.value as BriefingInput | undefined;

    if (!request) {
      return {
        status: "fail",
        error: {
          message: "Missing request context in memory."
        }
      };
    }

    const actionPlan = [
      `Restate the request from ${request.customerName}.`,
      `Respect constraints: ${request.constraints.join(", ") || "none"}.`,
      request.priority === "high"
        ? "Escalate the plan for same-day review."
        : "Queue the plan for normal review."
    ];

    const artifact = await ctx.artifacts.create({
      name: "briefing-plan.json",
      mimeType: "application/json",
      bytes: new TextEncoder().encode(
        JSON.stringify(
          {
            workflowId: ctx.workflowId,
            customerName: request.customerName,
            request: request.request,
            priority: request.priority,
            actionPlan
          },
          null,
          2
        )
      ),
      meta: {
        task: this.name
      }
    });

    await ctx.memory.put({
      key: `artifact.${artifact.artifactId}.briefing`,
      scope: "workflow",
      category: "artifact",
      description: "Artifact metadata for generated briefing plan",
      keywords: ["artifact", "briefing", "plan"],
      value: {
        artifactId: artifact.artifactId,
        name: artifact.name,
        uri: artifact.uri
      },
      importance: 0.8,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
      sourceTask: this.name
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

const memoryStore = new InMemoryMemoryStore();
const artifactStore = new InMemoryArtifactStore();
const renderer = createCLIRenderer(resolveRendererOptions());
const cycle = createCycle({
  memoryStore,
  artifactStore,
  observers: [renderer]
});

cycle.register("customer-briefing", ConsumerWorkflow);

const input: BriefingInput = {
  customerName: "Skyend Retail",
  request: "Create a rollout briefing for the first AX Workflow MVP pilot.",
  priority: "high",
  constraints: ["Keep the first release sequential only", "Show CLI line mode output"]
};

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
