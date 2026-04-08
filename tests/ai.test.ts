import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  createCLIRenderer,
  createCycle,
  createWorkflowInput,
  InMemoryArtifactStore,
  InMemoryMemoryEngine,
  OpenAISummaryWorkflow,
  Task,
  type AIChatRequest,
  type AIChatResponse,
  type AIChatStream,
  type AIProvider,
  type TaskResult,
  type WorkflowContext,
  type WorkflowDefinition
} from "../src/index.js";

describe("AI provider integration", () => {
  it("lets tasks call ctx.ai.chat through a configured provider", async () => {
    const requests: AIChatRequest[] = [];
    const aiProvider: AIProvider = {
      provider: "mock-openai",
      defaultChatModel: "gpt-test",
      async chat(request): Promise<AIChatResponse> {
        requests.push(request);
        return {
          provider: "mock-openai",
          model: request.model ?? "gpt-test",
          outputText: "Mocked AI summary for the current workflow run.",
          message: {
            role: "assistant",
            content: "Mocked AI summary for the current workflow run."
          },
          finishReason: "stop"
        };
      },
      async chatStream(request): Promise<AIChatStream> {
        requests.push(request);

        return {
          async *[Symbol.asyncIterator]() {
            yield {
              provider: "mock-openai",
              model: request.model ?? "gpt-test",
              deltaText: "Mocked AI summary for the current workflow run.",
              outputText: "Mocked AI summary for the current workflow run.",
              finishReason: "stop"
            };
          },
          finalResponse: Promise.resolve({
            provider: "mock-openai",
            model: request.model ?? "gpt-test",
            outputText: "Mocked AI summary for the current workflow run.",
            message: {
              role: "assistant",
              content: "Mocked AI summary for the current workflow run."
            },
            finishReason: "stop"
          })
        };
      }
    };

    const memoryEngine = new InMemoryMemoryEngine();
    const artifactStore = new InMemoryArtifactStore();
    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk) => {
      output += chunk.toString();
    });

    const renderer = createCLIRenderer({
      enabled: false,
      stream: stream as unknown as NodeJS.WriteStream
    });
    const cycle = createCycle({
      aiProvider,
      memoryEngine,
      artifactStore,
      observers: [renderer],
      now: (() => {
        let current = 2_000;
        return () => ++current;
      })()
    });

    cycle.register("openai-summary", OpenAISummaryWorkflow);
    const result = await cycle.run(
      "openai-summary",
      createWorkflowInput({
        objective: "Summarize AI configuration support in the library."
      }),
    );

    expect(result.frame.status).toBe("success");
    expect(result.frame.completedTasks).toEqual(["generateSummary", "publishSummary"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages[0]?.role).toBe("developer");

    const summary = await memoryEngine.get(
      `memory.workflow.summary.${result.frame.workflowId}.generateSummary`,
    );
    expect(summary && "contextSummary" in summary.payload ? summary.payload.contextSummary : undefined).toBe(
      "Mocked AI summary for the current workflow run.",
    );

    const artifacts = await artifactStore.list();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe("ai-summary.md");

    expect(output).toContain("[INFO] task generateSummary Calling AI chat completion");
    expect(output).toContain("[SUCCESS] task generateSummary Stored AI summary");
  });

  it("automatically logs prompt and output metadata for ctx.ai.chat()", async () => {
    const aiProvider: AIProvider = {
      provider: "mock-openai",
      defaultChatModel: "gpt-test",
      async chat(request): Promise<AIChatResponse> {
        return {
          provider: "mock-openai",
          model: request.model ?? "gpt-test",
          outputText: "Acknowledged for monitoring.",
          message: {
            role: "assistant",
            content: "Acknowledged for monitoring."
          },
          finishReason: "stop"
        };
      },
      async chatStream(): Promise<AIChatStream> {
        throw new Error("stream not used in this test");
      }
    };

    class MonitoringTask extends Task {
      name = "monitor";
      memoryPhase = "EXECUTION" as const;
      memoryTaskType = "workflow" as const;

      async run(ctx: WorkflowContext): Promise<TaskResult> {
        await ctx.ai.chat({
          messages: [
            { role: "developer", content: "Return a short acknowledgement." },
            { role: "user", content: "Monitor this prompt and output length." }
          ]
        });

        return {
          status: "success"
        };
      }
    }

    const workflow: WorkflowDefinition = {
      name: "monitoring",
      start: "monitor",
      end: "end",
      tasks: {
        monitor: new MonitoringTask()
      },
      transitions: {
        monitor: {
          success: "end",
          fail: "end"
        }
      }
    };

    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk) => {
      output += chunk.toString();
    });

    const renderer = createCLIRenderer({
      enabled: false,
      stream: stream as unknown as NodeJS.WriteStream
    });
    const cycle = createCycle({
      aiProvider,
      observers: [renderer]
    });

    cycle.register("monitoring", workflow);
    const result = await cycle.run("monitoring", createWorkflowInput({ requestId: "issue-4" }));

    expect(result.frame.status).toBe("success");
    expect(output).toContain("[INFO] task monitor AI chat request");
    expect(output).toContain("promptLength=");
    expect(output).toContain("[SUCCESS] task monitor AI chat response");
    expect(output).toContain("outputLength=");
  });
});
