import type { PassThrough } from "node:stream";

// Keep host helpers independent of either the local or published library build.
type SampleRendererOptions = {
  enabled: boolean;
  mode?: "off" | "line" | "compact" | "ink" | "dashboard" | "jsonl" | "plain";
  logLevel?: "debug" | "info" | "warn" | "error" | "success";
};

export function resolveRendererOptions(
  env: NodeJS.ProcessEnv = process.env,
): SampleRendererOptions {
  const mode = env.CYCLE_RENDER_MODE as SampleRendererOptions["mode"];
  const logLevel = env.CYCLE_LOG_LEVEL as SampleRendererOptions["logLevel"];
  return {
    enabled: env.CYCLE_LIVE !== "0",
    ...(mode ? { mode } : {}),
    ...(logLevel ? { logLevel } : {}),
  };
}

export function resolveHTTPDebugEnabled(
  value: boolean | Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return typeof value.enabled === "boolean" ? value.enabled : true;
  }
  return ["1", "true", "yes", "on"].includes((env.OPENAI_HTTP_DEBUG ?? "").toLowerCase());
}

export function withDebugStream<T extends { httpDebugLogging?: boolean | Record<string, unknown> }>(
  options: T,
  debugLogStream: PassThrough | undefined,
): T {
  if (!debugLogStream || !resolveHTTPDebugEnabled(options.httpDebugLogging)) return options;
  const current = options.httpDebugLogging;
  return {
    ...options,
    httpDebugLogging:
      current && typeof current === "object" && !Array.isArray(current)
        ? { ...current, stream: debugLogStream }
        : { enabled: true, stream: debugLogStream },
  };
}

export function resolveRequestHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  if (!env.CYCLE_REQUEST_HEADERS_JSON) return undefined;
  const parsed: unknown = JSON.parse(env.CYCLE_REQUEST_HEADERS_JSON);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CYCLE_REQUEST_HEADERS_JSON must be a JSON object.");
  }
  const headers = Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return Object.keys(headers).length ? headers : undefined;
}
