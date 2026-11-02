import type {
  AIChatRequest,
  AIChatResponse,
  AIChatStream,
  AIChatStreamChunk,
  AIProvider,
  CommandAIProviderOptions,
} from "../../types.js";
import { combineAbortSignals } from "../../shared/abort.js";
import { AsyncQueue } from "../openai/queue.js";
import { toProviderRequestError } from "../openai/errors.js";
import { resolveRequestModel } from "../payload.js";
import { buildCommandMessage, commandArguments } from "./messages.js";
import { runCommand } from "./process.js";

function assertActive(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const timedOut =
    signal.reason instanceof Error && signal.reason.name === "TimeoutError";
  throw Object.assign(
    new Error(
      timedOut
        ? "Command execution timed out."
        : "Command execution was cancelled.",
      { cause: signal.reason },
    ),
    { code: timedOut ? "command_timeout" : "command_aborted" },
  );
}

class CommandAIProvider implements AIProvider {
  readonly apiType = "command" as const;
  readonly provider: string;
  readonly defaultChatModel: string | undefined;
  constructor(private readonly options: CommandAIProviderOptions) {
    this.provider = options.providerName ?? "command";
    this.defaultChatModel = options.defaultModel;
    const settings = options.command;
    if (
      !settings ||
      typeof settings.executable !== "string" ||
      !settings.executable.trim() ||
      settings.executable.includes("\0")
    )
      throw new Error("Command provider requires command.executable.");
    if (
      settings.args !== undefined &&
      (!Array.isArray(settings.args) ||
        settings.args.some((arg) => typeof arg !== "string"))
    )
      throw new Error("Command args must be a string array.");
    if (
      settings.input !== undefined &&
      settings.input !== "argument" &&
      settings.input !== "stdin"
    )
      throw new Error("Command input must be argument or stdin.");
    if (
      settings.maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(settings.maxOutputBytes) ||
        settings.maxOutputBytes < 1)
    )
      throw new Error(
        "Command maxOutputBytes must be a positive safe integer.",
      );
    for (const callback of [settings.buildMessage, settings.parseOutput])
      if (callback !== undefined && typeof callback !== "function")
        throw new Error("Command buildMessage/parseOutput must be functions.");
  }
  async chat(request: AIChatRequest): Promise<AIChatResponse> {
    const model = resolveRequestModel(
      request,
      this.defaultChatModel,
      this.options.defaultPayload,
    );
    const timeout = request.http?.timeoutMs ?? this.options.timeoutMs ?? 60_000;
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 2_147_483_647)
      throw new Error(
        "Command timeoutMs must be an integer between 0 and 2147483647.",
      );
    const signal =
      combineAbortSignals([
        request.http?.signal,
        ...(timeout ? [AbortSignal.timeout(timeout)] : []),
      ]) ?? new AbortController().signal;
    try {
      assertActive(signal);
      const message = buildCommandMessage(
        request,
        this.options.command,
        this.options.defaultPayload,
      );
      const args = commandArguments(this.options.command, message, model);
      const raw = await runCommand(
        this.options.command,
        args,
        this.options.command.input === "stdin" ? message : undefined,
        signal,
      );
      assertActive(signal);
      const answer = this.options.command.parseOutput
        ? this.options.command.parseOutput(raw, request)
        : { text: raw.stdout };
      if (!answer || typeof answer.text !== "string")
        throw new Error("Command parseOutput must return text as a string.");
      return {
        provider: this.provider,
        model: answer.model ?? model ?? "command",
        outputText: answer.text,
        message: { role: "assistant", content: answer.text },
        finishReason: answer.finishReason ?? "stop",
        ...(answer.usage ? { usage: answer.usage } : {}),
        raw: { ...raw, buffered: true },
      };
    } catch (error) {
      throw toProviderRequestError(this.provider, model, error);
    }
  }
  async chatStream(request: AIChatRequest): Promise<AIChatStream> {
    const cancellation = new AbortController();
    const queue = new AsyncQueue<AIChatStreamChunk>(() => cancellation.abort());
    const pending = this.chat({
      ...request,
      http: {
        ...request.http,
        signal: combineAbortSignals([
          request.http?.signal,
          cancellation.signal,
        ])!,
      },
    });
    const finalResponse = pending.then(
      (response) => {
        queue.push({
          provider: response.provider,
          model: response.model,
          deltaText: response.outputText,
          outputText: response.outputText,
          ...(response.finishReason !== undefined
            ? { finishReason: response.finishReason }
            : {}),
          ...(response.usage ? { usage: response.usage } : {}),
          raw: response.raw,
        });
        queue.close();
        return response;
      },
      (error) => {
        queue.fail(error);
        throw error;
      },
    );
    void finalResponse.catch(() => undefined);
    return {
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      finalResponse,
    };
  }
}

export function createCommandAIProvider(
  options: CommandAIProviderOptions,
): AIProvider {
  return new CommandAIProvider(options);
}
