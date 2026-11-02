import type { AIChatRequest, CommandProviderSettings } from "../../types.js";
import { mergePayload } from "../payload.js";

export function buildCommandMessage(
  request: AIChatRequest,
  settings: CommandProviderSettings,
  defaults?: Record<string, unknown>,
): string {
  const explicit = request.command?.message ?? settings.buildMessage?.(request);
  if (explicit !== undefined) {
    if (typeof explicit !== "string")
      throw new Error("Command message/buildMessage must return a string.");
    return explicit;
  }
  if (
    request.payload !== undefined ||
    defaults !== undefined ||
    request.payloadMode === "replace"
  ) {
    return JSON.stringify(
      mergePayload(request, defaults, {
        ...(request.messages !== undefined
          ? { messages: request.messages }
          : {}),
        ...(request.model !== undefined ? { model: request.model } : {}),
      }),
    );
  }
  const messages = request.messages;
  if (!messages?.length)
    throw new Error(
      "Command chat requires messages, payload, or command.message.",
    );
  return messages
    .map((message) => {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((part) => {
                if (part.type !== "text" && part.type !== "input_text")
                  throw new Error(
                    "Command text input requires text content. Use payload or buildMessage for multimodal input.",
                  );
                return part.text;
              })
              .join("");
      return messages.length === 1 && message.role === "user" && !message.name
        ? text
        : `[${message.role}${message.name ? `:${message.name}` : ""}]\n${text}`;
    })
    .join("\n\n");
}

export function commandArguments(
  settings: CommandProviderSettings,
  message: string,
  model?: string,
): string[] {
  const templates =
    settings.args ?? (settings.input === "stdin" ? [] : ["-p", "{message}"]);
  if (
    settings.input !== "stdin" &&
    !templates.some((arg) => arg.includes("{message}"))
  )
    throw new Error(
      "Command argument input requires a {message} argument template.",
    );
  return templates.map((arg) => {
    const value = arg.replace(/\{(message|model)\}/gu, (_, key: string) => {
      if (key === "message") return message;
      if (!model) throw new Error("Command {model} template requires a model.");
      return model;
    });
    if (value.includes("\0"))
      throw new Error("Command arguments cannot contain NUL bytes.");
    return value;
  });
}
