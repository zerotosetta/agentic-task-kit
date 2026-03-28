# agentic-task-kit

Cycle foundation MVP 를 구현하는 저장소입니다.
이 패키지는 AX Workflow 를 구현할 수 있는 Node.js + TypeScript 라이브러리의 최소 실행 가능 범위를 제공합니다.

## 현재 포함 범위
- sequential workflow engine
- in-memory memory store
- in-memory artifact store
- execution event stream
- `TaskLogger` / `ctx.log`
- `ctx.ai.chat()` provider interface
- OpenAI Chat Completions adapter
- compact CLI renderer
- live rendering off line mode
- sample `ReportWorkflow`

## 저장소 구성
- `src/`: 라이브러리 소스 코드
- `tests/`: unit / integration test
- `scripts/`: example consumer runner
- `docs/`: 로컬 실행 및 runtime 참고 문서

## 시작하기
1. 의존성 설치:
```bash
npm install
```
2. 타입 검사:
```bash
npm run typecheck
```
3. 테스트 실행:
```bash
npm test
```
4. example workflow 실행:
```bash
npm run example
```
5. consumer example 실행:
```bash
npm run example:consumer
```
6. OpenAI Chat example 실행:
```bash
OPENAI_API_KEY=your_key_here npm run example:openai
```

## CLI renderer 빠른 사용법
- live rendering on:
```bash
npm run example
```
- live rendering off:
```bash
CYCLE_LIVE=0 npm run example
```
- line mode 강제:
```bash
CYCLE_RENDER_MODE=line npm run example
```
- OpenAI example line mode:
```bash
OPENAI_API_KEY=your_key_here CYCLE_LIVE=0 npm run example:openai
```

## Examples
- baseline sample workflow:
```bash
npm run example
```
- consumer-defined workflow:
```bash
npm run example:consumer
```
- consumer-defined workflow with line mode:
```bash
CYCLE_LIVE=0 npm run example:consumer
```
- OpenAI Chat workflow:
```bash
OPENAI_API_KEY=your_key_here npm run example:openai
```

## OpenAI provider quick usage
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

## 문서
- [local setup](/Users/fortrit/workspace/agentic-task-kit/agentic-task-kit/docs/local-setup.md)
- [runtime overview](/Users/fortrit/workspace/agentic-task-kit/agentic-task-kit/docs/runtime-overview.md)
- [consumer example](/Users/fortrit/workspace/agentic-task-kit/agentic-task-kit/docs/consumer-example.md)
- [OpenAI Chat API](/Users/fortrit/workspace/agentic-task-kit/agentic-task-kit/docs/openai-chat-api.md)
