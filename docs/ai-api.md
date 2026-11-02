# 다양한 AI API와 원본 payload

`createAIProvider()` 에서 모델이 사용하는 API 형식을 선택한다. 모델 이름은 사용자가 지정하며 라이브러리가 이름으로 API 유형을 추측하지 않는다.

| `apiType` | 기본 endpoint | 공통 메시지 변환 |
| --- | --- | --- |
| `openai-chat-completions` (기본) | OpenAI `/v1/chat/completions` | `messages` |
| `openai-responses` | OpenAI `/v1/responses` | `input`, `max_output_tokens`, `reasoning.effort` |
| `anthropic-messages` | Anthropic `/v1/messages` | `system`, `messages`, `max_tokens` |
| `gemini-generate-content` | Gemini `/v1beta/models/{model}:generateContent` | `systemInstruction`, `contents`, `generationConfig` |
| `webchat` | [세션 기반 WebChat](./webchat-api.md) | 세션 생성 → 메시지 등록 → 설정된 답변 확인 |

호환 서버는 `baseURL` 과 `defaultHeaders` 로 지정한다. 기존 `createOpenAICompatibleChatProvider()` / `createOpenAIChatProvider()` 도 유지되며 같은 옵션을 지원한다.

```ts
import { createAIProvider, createCycle } from "agentic-task-kit";

const ai = createAIProvider({
  apiType: "openai-responses",
  apiKey: process.env.OPENAI_API_KEY!,
  defaultModel: process.env.OPENAI_MODEL!,
  defaultPayload: { store: false },
});
const cycle = createCycle({ aiProvider: ai });

// 기존 공통 메시지 방식도 그대로 사용할 수 있다.
const response = await ai.chat({
  messages: [{ role: "user", content: "입력을 요약해줘." }],
  maxCompletionTokens: 500,
});
```

## 원본 payload

`payload` 는 필드 allowlist 없이 JSON object 의 키와 중첩 구조를 전달한다. 공통 `messages` 없이 `input`, `contents`, tool 결과, 오디오/파일 블록 등 API 고유 형식을 사용할 수 있다. 모델이 지원하는 필드인지에 대한 최종 검증은 API 서버가 수행한다.

```ts
const response = await ai.chat({
  payload: {
    input: "배송 상태를 확인해줘.",
    tools: [{
      type: "function",
      name: "lookup_order",
      description: "주문 상태 조회",
      parameters: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
        additionalProperties: false,
      },
      strict: true,
    }],
    tool_choice: "auto",
    reasoning: { effort: "low" },
  },
});
// tool call / multimodal output 등 원본 응답은 response.raw 에 있다.
```

병합 순서는 `defaultPayload` → 공통 옵션의 API별 변환 결과 → 요청 `payload` 이다. 각 최상위 키를 교체하는 shallow merge 이므로 `payload.generationConfig` 등을 지정하면 같은 키의 기본 object 전체를 대체한다. 입력 object 는 변경하지 않는다.

`payloadMode: "replace"` 는 공통 메시지 변환과 `defaultPayload` 를 건너뛴다. API 필수 필드도 직접 제공한다. 단, `chat()` / `chatStream()` 이 사용하는 `stream` 플래그는 호출 방식에 맞춘다. Gemini 는 URL과 `alt=sse` 로 스트리밍을 선택한다.

```ts
await ai.chat({
  payloadMode: "replace",
  payload: {
    model: process.env.OPENAI_MODEL!,
    input: [{ type: "function_call_output", call_id: "call_123", output: "배송 중" }],
    previous_response_id: "resp_123",
    store: false,
  },
});
```

Chat Completions 의 `max_tokens`, `response_format`, `tools`, `tool_calls`, `role: "tool"` 등도 `payload` / `defaultPayload` 로 직접 전달할 수 있다. 공통 content-part 타입에 없는 오디오/비디오/파일/도구 블록을 사용하려면 native payload 를 사용한다.

## Anthropic과 Gemini

```ts
const claude = createAIProvider({
  apiType: "anthropic-messages",
  apiKey: process.env.ANTHROPIC_API_KEY!,
  defaultModel: process.env.ANTHROPIC_MODEL!,
  defaultPayload: { max_tokens: 4096 },
});
await claude.chat({ payload: {
  system: "입력 문서를 분석해줘.",
  messages: [{ role: "user", content: [{ type: "text", text: "분석할 내용" }] }],
} });

const gemini = createAIProvider({
  apiType: "gemini-generate-content",
  apiKey: process.env.GEMINI_API_KEY!,
  defaultModel: process.env.GEMINI_MODEL!,
});
await gemini.chat({ payload: {
  contents: [{ role: "user", parts: [{ text: "입력을 요약해줘." }] }],
  generationConfig: { responseMimeType: "application/json" },
} });
```

공통 `maxCompletionTokens` 는 API별 token limit 으로 변환한다. Anthropic 은 limit 이 필수이므로 별도 지정이 없으면 `max_tokens: 1024` 를 사용한다. reasoning/thinking, safety, caching 등 모델별 설정은 원본 payload 에 명시한다. 공통 `reasoningEffort` 는 Chat Completions / Responses 에만 매핑한다.

## 설정 파일

```json
{
  "apiType": "anthropic-messages",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "defaultModel": "your-model-id",
  "defaultPayload": { "max_tokens": 4096 }
}
```

```ts
import { createAIProviderFromConfigFile } from "agentic-task-kit";
const ai = createAIProviderFromConfigFile({ configPath: "./cycle.ai.json" });
```

직접 생성 시 API별 `OPENAI_*`, `ANTHROPIC_*`, `GEMINI_*` 의 `API_KEY`, `BASE_URL`, `MODEL` 환경변수도 읽는다. Gemini 키는 `GOOGLE_API_KEY` 로도 지정할 수 있다. 다른 공급자의 환경변수로 인증을 대체하지 않는다.

## 스트리밍과 오류

```ts
const stream = await ai.chatStream({
  messages: [{ role: "user", content: "설명해줘." }],
});
for await (const chunk of stream) {
  process.stdout.write(chunk.deltaText);
  // tool/thinking/vendor event 의 원본은 chunk.raw 에 보존된다.
}
const result = await stream.finalResponse;
```

`outputText` / `deltaText` 는 표시할 텍스트이고, tool 호출을 자동 실행하지 않는다. 원본 응답과 이벤트는 `raw` 에 보존된다. reasoning/thinking 내용은 표시 텍스트에 섞지 않는다.

자체 `AIProvider` 구현에서는 `AIChatRequest.messages` 가 선택 필드인 점을 반영한다. 공통 메시지만 지원하는 자체 provider 는 해당 필드를 검사하고, 원본 형식을 지원하면 `payload` 를 처리한다. 라이브러리의 모니터링/취소 wrapper 는 원본 payload 호출도 지원한다.

native API 는 60초의 요청 timeout 및 최대 2회 재시도를 기본 사용한다. `http.timeoutMs` / `http.maxRetries` 또는 provider 옵션으로 변경한다. `timeoutMs: 0` 은 timeout 을 끈다. HTTP 408/409/429/5xx 또는 연결 실패만 재시도하며, 이미 시작한 stream 을 재전송하지 않는다. `Retry-After` 는 최대 60초까지 반영한다. 기존 Chat Completions 은 OpenAI SDK 의 timeout/retry 기본값을 유지한다.

HTTP 오류와 stream 내부 오류는 `AIProviderRequestError` 로 전달한다. native stream 의 terminal event 가 없는 조기 EOF, timeout, 취소는 실패로 처리한다. iterator 를 조기에 반환하면 HTTP 요청을 중단한다. workflow cancellation 도 native payload 호출에 전달된다. 요청별 `http.headers`, `baseURL`, `signal` 을 사용할 수 있다.

실제 vendor 계정/모델의 지원 여부는 계정과 API 서버에 따른다. 네 가지 API 형식의 wire payload/JSON/SSE 및 lifecycle 은 로컬 mock 으로 검증한다.

공식 API 문서: [OpenAI Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses), [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create), [Gemini generateContent](https://ai.google.dev/api/generate-content).
