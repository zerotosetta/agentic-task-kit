# agentic-task-kit

Cycle foundation MVP 를 구현하는 저장소입니다.
이 패키지는 AX Workflow 를 구현할 수 있는 Node.js + TypeScript 라이브러리의 최소 실행 가능 범위를 제공합니다.

## 현재 포함 범위
- sequential workflow engine
- in-memory memory store
- in-memory artifact store
- execution event stream
- `TaskLogger` / `ctx.log`
- `ctx.ai.chat()` / `ctx.ai.chatStream()` provider interface
- OpenAI-compatible Chat Completions adapter
- separate OpenAI-compatible config file loading
- compact CLI renderer
- Ink 2-column TUI renderer
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
4. 단일 번들 생성:
```bash
npm run build
```
5. example workflow 실행:
```bash
npm run example
```
6. consumer example 실행:
```bash
npm run example:consumer
```
7. OpenAI Chat example 실행:
```bash
OPENAI_API_KEY=your_key_here npm run example:openai
```
8. OpenAI-compatible streaming example 실행:
```bash
OPENAI_API_KEY=your_key_here npm run example:openai:stream
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
- Ink TUI mode:
```bash
CYCLE_RENDER_MODE=ink npm run example
```
- OpenAI example line mode:
```bash
OPENAI_API_KEY=your_key_here CYCLE_LIVE=0 npm run example:openai
```
- OpenAI example Ink mode + HTTP debug log:
```bash
OPENAI_API_KEY=your_key_here OPENAI_HTTP_DEBUG=1 CYCLE_LOG_LEVEL=debug CYCLE_RENDER_MODE=ink npm run example:openai
```

## Ink TUI
`CYCLE_RENDER_MODE=ink` 이면 interactive TTY 에서 Ink 전체화면 TUI 를 사용한다.

- 좌측 40%: workflow 상태, 현재 task, task 실행 이력
- 우측 60%: task 로그와 provider HTTP debug 로그 타임라인
- `Tab`: 패널 전환
- `↑↓` / `j k`: 현재 패널 스크롤
- `PageUp/PageDown`: 페이지 단위 스크롤
- `Home/End`, `g/G`: 처음/끝 이동
- `CYCLE_LOG_LEVEL=debug`: task debug log 와 provider HTTP debug log 노출

interactive TTY 가 아니면 `ink` 모드는 `jsonl` 로 자동 fallback 된다.

## Build
배포 산출물은 `esbuild` 로 만든 단일 ESM 번들 `dist/index.js` 와 타입 선언 `dist/index.d.ts` 다. npm 런타임 의존성은 번들에 포함되고 Node.js built-in module 만 external 로 남는다.

```bash
npm run clean
npm run build:types
npm run build:bundle
npm run build
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
- consumer-defined workflow with Ink TUI:
```bash
CYCLE_RENDER_MODE=ink npm run example:consumer
```
- OpenAI Chat workflow:
```bash
OPENAI_API_KEY=your_key_here npm run example:openai
```
- OpenAI-compatible streaming workflow:
```bash
OPENAI_API_KEY=your_key_here npm run example:openai:stream
```
- AXPM-hosted Java modernization pipeline example:
```bash
cd /Users/fortrit/workspace/agentic-task-kit/agentic-task-kit-axpm/example-project
npm install
npm run start
```

## Config file
OpenAI-compatible 설정은 코드나 env 뿐 아니라 별도 JSON 파일로도 읽을 수 있습니다.

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

`CYCLE_OPENAI_COMPATIBLE_CONFIG_PATH`, `CYCLE_OPENAI_CONFIG_PATH`, `OPENAI_CONFIG_PATH` 로도 경로를 지정할 수 있습니다.

## OpenAI-compatible provider quick usage
```ts
import { createCycle, createOpenAICompatibleChatProvider } from "agentic-task-kit";

const cycle = createCycle({
  aiProvider: createOpenAICompatibleChatProvider({
    providerName: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "gpt-5.2",
    defaultHeaders: {
      "HTTP-Referer": "https://example.test/cycle"
    },
    httpDebugLogging: true,
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
- [sample project](/Users/fortrit/workspace/agentic-task-kit/agentic-task-kit/sample-project/README.md)
- [AXPM example project](/Users/fortrit/workspace/agentic-task-kit/agentic-task-kit-axpm/example-project/README.md)
