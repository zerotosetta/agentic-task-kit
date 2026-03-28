# OpenAI Chat API

`Cycle` 는 `createOpenAIChatProvider()` 로 OpenAI Chat Completions 기반 AI 호출을 연결할 수 있다.

## 기본 사용
```ts
import { createCycle, createOpenAIChatProvider } from "agentic-task-kit";

const cycle = createCycle({
  aiProvider: createOpenAIChatProvider({
    defaultModel: "gpt-5.2",
    timeoutMs: 20_000,
    maxRetries: 2
  })
});
```

task 에서는 `ctx.ai.chat()` 로 호출한다.

```ts
const completion = await ctx.ai.chat({
  messages: [
    {
      role: "developer",
      content: "Summarize the input for an AX Workflow task."
    },
    {
      role: "user",
      content: JSON.stringify(ctx.input)
    }
  ]
});
```

## 지원 설정
- `apiKey`
- `baseURL`
- `organization`
- `project`
- `defaultModel`
- `timeoutMs`
- `maxRetries`
- `defaultTemperature`
- `defaultMaxCompletionTokens`
- `defaultReasoningEffort`

## 환경 변수
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_ORG_ID`
- `OPENAI_PROJECT_ID`
- `OPENAI_MODEL`
- `OPENAI_TIMEOUT_MS`
- `OPENAI_MAX_RETRIES`
- `OPENAI_MAX_COMPLETION_TOKENS`
- `OPENAI_REASONING_EFFORT`

명시적 옵션이 환경 변수보다 우선한다.

## 예제 실행
```bash
OPENAI_API_KEY=your_key_here npm run example:openai
```

line mode 로 확인하려면:
```bash
OPENAI_API_KEY=your_key_here CYCLE_LIVE=0 npm run example:openai
```

## 참고
- 이 adapter 는 현재 OpenAI Chat Completions API 기준이다.
- OpenAI 공식 문서는 신규 프로젝트에 Responses API 를 우선 권장하지만, 이 라이브러리의 현재 adapter 는 사용자 요청에 맞춰 Chat Completions 를 먼저 지원한다.
