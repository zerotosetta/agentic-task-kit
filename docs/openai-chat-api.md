# OpenAI-compatible Chat API

`Cycle` 는 `createOpenAICompatibleChatProvider()` 로 OpenAI Chat Completions 스펙 기반 AI 호출을 연결할 수 있다.
기본 OpenAI API 뿐 아니라 같은 스펙을 따르는 다른 model API 로도 `baseURL` 과 `defaultHeaders` 만 바꿔 쉽게 전환할 수 있다.
설정은 별도 JSON 파일 경로로도 읽을 수 있다.

## 기본 사용
```ts
import { createCycle, createOpenAICompatibleChatProvider } from "agentic-task-kit";

const cycle = createCycle({
  aiProvider: createOpenAICompatibleChatProvider({
    providerName: "openai",
    defaultModel: "gpt-5.2",
    httpDebugLogging: true,
    timeoutMs: 20_000,
    maxRetries: 2
  })
});
```

설정 파일 사용:

```ts
import {
  createCycle,
  createOpenAICompatibleChatProviderFromConfigFile
} from "agentic-task-kit";

const cycle = createCycle({
  aiProvider: createOpenAICompatibleChatProviderFromConfigFile({
    configPath: "./cycle.config.json"
  })
});
```

task 에서는 `ctx.ai.chat()` 로 호출한다.

```ts
import { workflowInputToPrettyJson } from "agentic-task-kit";

const completion = await ctx.ai.chat({
  messages: [
    {
      role: "developer",
      content: "Summarize the input for an AX Workflow task."
    },
    {
      role: "user",
      content: workflowInputToPrettyJson(ctx.input)
    }
  ]
});
```

content-part 입력:

```ts
const completion = await ctx.ai.chat({
  messages: [
    {
      role: "developer",
      content: [{ type: "text", text: "Summarize the request." }]
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Analyze this payload." },
        { type: "image_url", imageUrl: "https://example.test/input.png", detail: "low" }
      ]
    }
  ]
});
```

지원 규칙:
- `user`: `string` 또는 text/image content-part 배열
- `developer`, `system`, `assistant`: `string` 또는 text content-part 배열
- non-text part 를 `developer` / `system` / `assistant` 에 넣으면 provider mapping 단계에서 에러가 발생한다.

요청 단위 header 추가:

```ts
const completion = await ctx.ai.chat({
  messages: [
    {
      role: "user",
      content: "Summarize this payload."
    }
  ],
  http: {
    headers: {
      "X-Request-ID": "workflow-run-123"
    }
  }
});
```

streaming 응답:

```ts
const stream = await ctx.ai.chatStream({
  messages: [
    {
      role: "user",
      content: "Stream a short summary."
    }
  ]
});

for await (const chunk of stream) {
  process.stdout.write(chunk.deltaText);
}

const response = await stream.finalResponse;
```

HTTP debug logging:

```ts
const provider = createOpenAICompatibleChatProvider({
  defaultModel: "gpt-5.2",
  httpDebugLogging: {
    includeHeaders: true,
    includeResponseHeaders: true,
    includeRequestBody: false
  }
});
```

HTTP error detail handling:

```ts
import {
  AIProviderRequestError,
  createOpenAICompatibleChatProvider
} from "agentic-task-kit";

const provider = createOpenAICompatibleChatProvider({
  defaultModel: "gpt-5.2"
});

try {
  await provider.chat({
    messages: [{ role: "user", content: "Trigger an error." }]
  });
} catch (error) {
  if (error instanceof AIProviderRequestError) {
    console.error("status", error.status);
    console.error("response", error.responseBody);
    console.error("original", error.originalError);
  }

  throw error;
}
```

## 지원 설정
- `providerName`
- `apiKey`
- `baseURL`
- `organization`
- `project`
- `defaultHeaders`
- `httpDebugLogging`
- `defaultModel`
- `timeoutMs`
- `maxRetries`
- `defaultTemperature`
- `defaultMaxCompletionTokens`
- `defaultReasoningEffort`

HTTP 실패 시:
- throw 되는 error 는 `AIProviderRequestError`
- `status`, `responseBody`, `requestId`, `code`, `type`, `param`, `originalError` 를 읽을 수 있음
- `message` 에 status 와 response body 요약이 포함됨

## 환경 변수
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_ORG_ID`
- `OPENAI_PROJECT_ID`
- `OPENAI_MODEL`
- `OPENAI_TIMEOUT_MS`
- `OPENAI_MAX_RETRIES`
- `OPENAI_HTTP_DEBUG`
- `OPENAI_HTTP_DEBUG_HEADERS`
- `OPENAI_HTTP_DEBUG_RESPONSE_HEADERS`
- `OPENAI_HTTP_DEBUG_BODY`
- `OPENAI_PROVIDER_NAME`
- `OPENAI_DEFAULT_HEADERS_JSON`
- `OPENAI_MAX_COMPLETION_TOKENS`
- `OPENAI_REASONING_EFFORT`
- `CYCLE_OPENAI_COMPATIBLE_CONFIG_PATH`
- `CYCLE_OPENAI_CONFIG_PATH`
- `OPENAI_CONFIG_PATH`

명시적 옵션이 환경 변수보다 우선한다.

## 설정 파일 형식
```json
{
  "openaiCompatible": {
    "providerName": "openrouter",
    "apiKeyEnv": "OPENAI_API_KEY",
    "baseURL": "https://openrouter.ai/api/v1",
    "defaultHeaders": {
      "HTTP-Referer": "https://example.test/cycle",
      "X-Title": "Cycle Sample"
    },
    "httpDebugLogging": {
      "enabled": true,
      "includeHeaders": true,
      "includeResponseHeaders": true
    },
    "defaultModel": "openai/gpt-5.2-mini",
    "timeoutMs": 20000,
    "maxRetries": 2
  }
}
```

지원 필드:
- `providerName`
- `apiKey`
- `apiKeyEnv`
- `baseURL`
- `baseURLEnv`
- `organization`
- `organizationEnv`
- `project`
- `projectEnv`
- `defaultHeaders`
- `httpDebugLogging`
- `defaultModel`
- `timeoutMs`
- `maxRetries`
- `defaultTemperature`
- `defaultMaxCompletionTokens`
- `defaultReasoningEffort`

기존 `openai` 섹션도 계속 읽을 수 있다.

## 예제 실행
```bash
OPENAI_API_KEY=your_key_here npm run example:openai
```

streaming 예제 실행:
```bash
OPENAI_API_KEY=your_key_here npm run example:openai:stream
```

line mode 로 확인하려면:
```bash
OPENAI_API_KEY=your_key_here CYCLE_LIVE=0 npm run example:openai
```

설정 파일 경로 지정:
```bash
OPENAI_API_KEY=your_key_here CYCLE_OPENAI_CONFIG_PATH=./cycle.config.json npm run example:openai
```

요청 단위 headers 지정:
```bash
OPENAI_API_KEY=your_key_here \
CYCLE_REQUEST_HEADERS_JSON='{"X-Request-ID":"example-run-1"}' \
npm run example:openai
```

HTTP debug 로그 활성화:
```bash
OPENAI_API_KEY=your_key_here OPENAI_HTTP_DEBUG=1 npm run example:openai
```

Ink TUI 에서 provider debug 로그까지 같이 보려면:
```bash
OPENAI_API_KEY=your_key_here \
OPENAI_HTTP_DEBUG=1 \
CYCLE_LOG_LEVEL=debug \
CYCLE_RENDER_MODE=ink \
npm run example:openai
```

## 참고
- 이 adapter 는 현재 OpenAI Chat Completions API 기준이다.
- `createOpenAIChatProvider()` / `createOpenAIChatProviderFromConfigFile()` 는 하위 호환 alias 로 유지된다.
- OpenAI 공식 문서는 신규 프로젝트에 Responses API 를 우선 권장하지만, 이 라이브러리의 현재 adapter 는 사용자 요청에 맞춰 Chat Completions 를 먼저 지원한다.
