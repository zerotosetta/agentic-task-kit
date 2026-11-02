import type { OpenAICompatibleChatProviderOptions } from "../../types.js";

export type ResolvedAIHTTPDebugLoggingOptions = {
  stream: NodeJS.WritableStream;
  includeHeaders: boolean;
  includeResponseHeaders: boolean;
  includeRequestBody: boolean;
  redactHeaders: string[];
};

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

export function resolveHTTPDebugLogging(
  option: OpenAICompatibleChatProviderOptions["httpDebugLogging"],
): ResolvedAIHTTPDebugLoggingOptions | undefined {
  const explicitEnabled =
    option === undefined
      ? undefined
      : typeof option === "boolean"
        ? option
        : (option.enabled ?? true);
  const envEnabled = parseOptionalBoolean(process.env.OPENAI_HTTP_DEBUG);
  const enabled = explicitEnabled ?? envEnabled ?? false;

  if (!enabled) {
    return undefined;
  }

  const details =
    option && typeof option === "object" && !Array.isArray(option) ? option : undefined;

  return {
    stream: details?.stream ?? process.stderr,
    includeHeaders:
      details?.includeHeaders ??
      parseOptionalBoolean(process.env.OPENAI_HTTP_DEBUG_HEADERS) ??
      true,
    includeResponseHeaders:
      details?.includeResponseHeaders ??
      parseOptionalBoolean(process.env.OPENAI_HTTP_DEBUG_RESPONSE_HEADERS) ??
      true,
    includeRequestBody:
      details?.includeRequestBody ??
      parseOptionalBoolean(process.env.OPENAI_HTTP_DEBUG_BODY) ??
      false,
    redactHeaders: details?.redactHeaders ?? ["authorization", "api-key", "x-api-key"],
  };
}

function toHeaderObject(headers: Headers, redactHeaders: string[]): Record<string, string> {
  const redactions = new Set(redactHeaders.map((header) => header.toLowerCase()));
  const entries: Record<string, string> = {};

  headers.forEach((value, key) => {
    entries[key] = redactions.has(key.toLowerCase()) ? "[REDACTED]" : value;
  });

  return entries;
}

function estimateBodyBytes(body: unknown): number | undefined {
  if (typeof body === "string") {
    return Buffer.byteLength(body);
  }

  if (body instanceof Uint8Array) {
    return body.byteLength;
  }

  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }

  return undefined;
}

function serializeRequestBody(body: unknown): unknown {
  if (typeof body !== "string") {
    return "[non-text body omitted]";
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function resolveRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) {
    return init.method;
  }

  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method;
  }

  return "GET";
}

function resolveRequestURL(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }

  return String(input);
}

export function writeHTTPDebugLog(
  config: ResolvedAIHTTPDebugLoggingOptions,
  payload: Record<string, unknown>,
): void {
  config.stream.write(`[cycle:http] ${JSON.stringify(payload)}\n`);
}

export function createDebugLoggingFetch(
  providerName: string,
  config: ResolvedAIHTTPDebugLoggingOptions,
  baseFetch: typeof fetch,
): typeof fetch {
  return async (input, init) => {
    const method = resolveRequestMethod(input, init);
    const url = resolveRequestURL(input);
    const startedAt = Date.now();
    const requestHeaders = new Headers(
      init?.headers ??
        (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined),
    );
    const requestBody = init?.body;

    writeHTTPDebugLog(config, {
      phase: "request",
      provider: providerName,
      method,
      url,
      bodyBytes: estimateBodyBytes(requestBody),
      ...(config.includeHeaders
        ? {
            headers: toHeaderObject(requestHeaders, config.redactHeaders),
          }
        : {}),
      ...(config.includeRequestBody
        ? {
            body: serializeRequestBody(requestBody),
          }
        : {}),
    });

    try {
      const response = await baseFetch(input, init);
      writeHTTPDebugLog(config, {
        phase: "response",
        provider: providerName,
        method,
        url,
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - startedAt,
        requestId: response.headers.get("x-request-id"),
        contentType: response.headers.get("content-type"),
        ...(config.includeResponseHeaders
          ? {
              headers: toHeaderObject(response.headers, config.redactHeaders),
            }
          : {}),
      });
      return response;
    } catch (error) {
      writeHTTPDebugLog(config, {
        phase: "error",
        provider: providerName,
        method,
        url,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}
