import {
  createCLIRenderer,
  createCycle,
  createWorkflowInput,
  InMemoryArtifactStore,
  InMemoryMemoryEngine,
  Task,
  type CLIRendererOptions,
  type CycleRunResult,
  type TaskResult,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowInput,
  type WorkflowMemory
} from "agentic-task-kit";

type ReleaseInput = {
  product: string;
  objective: string;
  services: string[];
  environment: string;
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

function requireReleaseInput(input: WorkflowInput): ReleaseInput {
  const object = Object.fromEntries(input.entries()) as Partial<ReleaseInput>;

  if (
    typeof object.product !== "string" ||
    typeof object.objective !== "string" ||
    !Array.isArray(object.services) ||
    object.services.some((service) => typeof service !== "string") ||
    typeof object.environment !== "string"
  ) {
    throw new Error("Release workflow input is missing required fields.");
  }

  return object as ReleaseInput;
}

function isPersistentInkRenderer(options: CLIRendererOptions): boolean {
  return options.enabled !== false && options.mode === "ink";
}

class PrepareReleaseTask extends Task {
  name = "prepareRelease";
  memoryPhase = "PLANNING" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = requireReleaseInput(ctx.input);
    ctx.log.info("Preparing parent workflow release plan", {
      product: input.product,
      services: input.services.length
    });

    const summary = [
      `${input.product} rollout objective: ${input.objective}.`,
      `Target environment: ${input.environment}.`,
      `Services: ${input.services.join(", ")}.`
    ].join(" ");

    await ctx.memory.write({
      id: `memory.workflow.summary.${ctx.workflowId}.prepare`,
      shard: "workflow",
      kind: "summary",
      payload: {
        workflowId: ctx.workflowId,
        currentStep: this.name,
        history: [],
        contextSummary: summary
      } satisfies WorkflowMemory,
      description: "Parent release workflow summary",
      keywords: ["release", "parent", "summary"],
      importance: 0.91,
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      sourceTask: this.name,
      phase: this.memoryPhase,
      taskType: this.memoryTaskType
    });

    return {
      status: "success",
      output: {
        summary
      }
    };
  }
}

class AnalyzeServicesTask extends Task {
  name = "analyzeServices";
  memoryPhase = "EXECUTION" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = requireReleaseInput(ctx.input);
    ctx.log.info("Launching child workflow branch", {
      branchId: "branch.service-analysis"
    });

    const child = await ctx.runSubWorkflow(
      "service-analysis",
      createWorkflowInput({
        product: input.product,
        services: input.services,
        environment: input.environment
      }),
      {
        branchId: "branch.service-analysis",
        summary: "Analyze service rollout branches"
      }
    );

    return {
      status: child.frame.status === "success" ? "success" : "fail",
      ...(child.frame.status === "success"
        ? {
            output: {
              childWorkflowId: child.frame.workflowId,
              childArtifacts: child.artifacts.artifacts.map((artifact) => artifact.name),
              childCompletedTasks: child.frame.completedTasks
            }
          }
        : {
            error: {
              message: child.frame.errors[child.frame.errors.length - 1] ?? "Child workflow failed"
            }
          })
    };
  }
}

class PublishReleaseTask extends Task {
  name = "publishRelease";
  memoryPhase = "REFLECTION" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = requireReleaseInput(ctx.input);
    const artifact = await ctx.artifacts.create({
      name: "release-rollout-summary.md",
      mimeType: "text/markdown",
      bytes: new TextEncoder().encode(
        [
          "# Release Rollout Summary",
          "",
          `- Product: ${input.product}`,
          `- Objective: ${input.objective}`,
          `- Environment: ${input.environment}`,
          `- Retrieved Context: ${ctx.memoryContext?.assembledContext ?? "none"}`
        ].join("\n")
      )
    });

    ctx.log.success("Published release rollout summary", {
      artifactId: artifact.artifactId
    });

    return {
      status: "success",
      output: artifact
    };
  }
}

class ServiceScanTask extends Task {
  name = "scanServices";
  memoryPhase = "PLANNING" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = Object.fromEntries(ctx.input.entries()) as {
      product: string;
      services: string[];
      environment: string;
    };

    ctx.log.info("Scanning child workflow services", {
      serviceCount: input.services.length
    });

    await ctx.memory.write({
      id: `memory.workflow.summary.${ctx.workflowId}.scan`,
      shard: "workflow",
      kind: "summary",
      payload: {
        workflowId: ctx.workflowId,
        currentStep: this.name,
        history: [],
        contextSummary: `${input.product} services scanned for ${input.environment}: ${input.services.join(", ")}`
      } satisfies WorkflowMemory,
      description: "Child workflow service scan summary",
      keywords: ["child", "services", "scan"],
      importance: 0.9,
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      sourceTask: this.name,
      phase: this.memoryPhase,
      taskType: this.memoryTaskType
    });

    return {
      status: "success",
      output: {
        services: input.services
      }
    };
  }
}

class GenerateChecklistTask extends Task {
  name = "generateChecklist";
  memoryPhase = "EXECUTION" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = Object.fromEntries(ctx.input.entries()) as {
      product: string;
      services: string[];
      environment: string;
    };

    const checklist = input.services.map((service, index) =>
      `${index + 1}. Validate ${service} deployment in ${input.environment}`
    );

    const artifact = await ctx.artifacts.create({
      name: "service-analysis-checklist.md",
      mimeType: "text/markdown",
      bytes: new TextEncoder().encode(
        [
          `# ${input.product} Service Analysis Checklist`,
          "",
          ...checklist
        ].join("\n")
      )
    });

    ctx.log.success("Generated child workflow checklist", {
      artifactId: artifact.artifactId
    });

    return {
      status: "success",
      output: {
        checklist,
        artifactId: artifact.artifactId
      }
    };
  }
}

const ParentWorkflow: WorkflowDefinition = {
  name: "release-orchestration",
  start: "prepareRelease",
  end: "end",
  tasks: {
    prepareRelease: new PrepareReleaseTask(),
    analyzeServices: new AnalyzeServicesTask(),
    publishRelease: new PublishReleaseTask()
  },
  transitions: {
    prepareRelease: {
      success: "analyzeServices",
      fail: "end"
    },
    analyzeServices: {
      success: "publishRelease",
      fail: "end"
    },
    publishRelease: {
      success: "end",
      fail: "end"
    }
  }
};

const ChildWorkflow: WorkflowDefinition = {
  name: "service-analysis",
  start: "scanServices",
  end: "end",
  tasks: {
    scanServices: new ServiceScanTask(),
    generateChecklist: new GenerateChecklistTask()
  },
  transitions: {
    scanServices: {
      success: "generateChecklist",
      fail: "end"
    },
    generateChecklist: {
      success: "end",
      fail: "end"
    }
  }
};

function printResult(result: CycleRunResult): void {
  const artifactNames = result.artifacts.artifacts.map((artifact) => artifact.name).join(", ") || "none";
  process.stdout.write(
    `Sub workflow example finished with status=${result.frame.status} completedTasks=${result.frame.completedTasks.join(",")} artifacts=${artifactNames} memoryRecords=${result.memory.records.length}\n`
  );
}

const rendererOptions = resolveRendererOptions();
const renderer = createCLIRenderer(rendererOptions);
const cycle = createCycle({
  memoryEngine: new InMemoryMemoryEngine(),
  artifactStore: new InMemoryArtifactStore(),
  observers: [renderer]
});

cycle.register("release-orchestration", ParentWorkflow);
cycle.register("service-analysis", ChildWorkflow);

const result = await cycle.run(
  "release-orchestration",
  createWorkflowInput({
    product: "Cycle",
    objective: "Validate the new sub workflow branch renderer in a release-ready scenario.",
    services: ["api-gateway", "workflow-engine", "reporting-worker"],
    environment: "staging"
  })
);

if (isPersistentInkRenderer(rendererOptions)) {
  process.stdin.resume();
} else {
  printResult(result);
  renderer.close();
}
