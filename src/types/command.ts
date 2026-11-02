import type { AIChatRequest, AIChatUsage, AIProviderOptions } from "./ai.js";

export type CommandExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
};
export type CommandAssistantResult = {
  text: string;
  model?: string;
  finishReason?: string;
  usage?: AIChatUsage;
};
export type CommandProviderSettings = {
  executable: string;
  /** Literal argv templates. Default: ["-p", "{message}"], or [] for stdin. */
  args?: readonly string[];
  input?: "argument" | "stdin";
  cwd?: string;
  /** Merge with the parent environment. null removes a variable. */
  env?: Record<string, string | null>;
  /** Combined stdout/stderr bytes. Default: 10 MiB. */
  maxOutputBytes?: number;
  buildMessage?(request: AIChatRequest): string;
  parseOutput?(
    result: CommandExecutionResult,
    request: AIChatRequest,
  ): CommandAssistantResult;
};
export type CommandRequestOptions = { message?: string };
export type CommandAIProviderOptions = Omit<
  AIProviderOptions,
  "apiType" | "command"
> & {
  apiType?: "command";
  command: CommandProviderSettings;
};
