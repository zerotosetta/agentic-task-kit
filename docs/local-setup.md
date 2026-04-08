# Local Setup

## Requirements
- Node.js 20+
- npm 10+

## Install
```bash
npm install
```

## Useful commands
```bash
npm run typecheck
npm test
npm run build
npm run example
npm run example:consumer
npm run example:openai
```

## CLI rendering
- live rendering on:
```bash
npm run example
```
- Ink TUI mode:
```bash
CYCLE_RENDER_MODE=ink npm run example
```
- line mode:
```bash
CYCLE_RENDER_MODE=line npm run example
```
- live rendering off:
```bash
CYCLE_LIVE=0 npm run example
```

Ink mode 에서는 좌측에 workflow/task history, 우측에 task log + provider debug log 가 2컬럼으로 출력된다.
`Tab`, `↑↓`, `j k`, `PageUp/PageDown`, `Home/End`, `g/G`, `q` 를 지원한다.
workflow 실행 중 `Ctrl+C` 는 active workflow graceful cancel 을 요청하고, run 종료가 관측되면 terminal reset + exit 를 수행한다. idle 상태에서는 즉시 terminal reset + exit 를 수행한다. 이 정책은 process `SIGINT` 와 Ink raw input 경로 모두에 동일하게 적용된다. `q` 는 명시적인 종료 키이며, active workflow 가 있으면 graceful cancel 후 종료하고 idle 상태에서는 즉시 종료한다.
TTY 가 아니면 `jsonl` 로 fallback 된다.

## Bundle build
```bash
npm run clean
npm run build
node -e \"import('./dist/index.js')\"
```

`npm run build` 는 `dist/index.js` 단일 ESM 번들과 `dist/index.d.ts` 타입 선언을 생성한다.

## OpenAI Chat API example
- required env:
```bash
export OPENAI_API_KEY=your_key_here
```
- run:
```bash
npm run example:openai
```
- optional env:
```bash
export OPENAI_MODEL=gpt-5.2
export OPENAI_TIMEOUT_MS=20000
export OPENAI_MAX_RETRIES=2
```
- OpenAI-compatible streaming:
```bash
OPENAI_API_KEY=your_key_here npm run example:openai:stream
```
- request-scoped headers:
```bash
OPENAI_API_KEY=your_key_here \
CYCLE_REQUEST_HEADERS_JSON='{"X-Request-ID":"local-example"}' \
npm run example:openai
```
- HTTP debug logging:
```bash
OPENAI_API_KEY=your_key_here OPENAI_HTTP_DEBUG=1 npm run example:openai
```
- Ink mode with HTTP debug logging:
```bash
OPENAI_API_KEY=your_key_here OPENAI_HTTP_DEBUG=1 CYCLE_LOG_LEVEL=debug CYCLE_RENDER_MODE=ink npm run example:openai
```

## Sample project
repo root example app:
```bash
cd sample-project
npm install
npm run typecheck
OPENAI_API_KEY=your_key_here npm run start
```

config file path override:
```bash
cd sample-project
OPENAI_API_KEY=your_key_here CYCLE_OPENAI_CONFIG_PATH=./cycle.config.json npm run start
```

streaming sample project run:
```bash
cd sample-project
OPENAI_API_KEY=your_key_here npm run start:stream
```

Java/JSP 5-stage Gemini sample project run:
```bash
cd sample-project
GEMINI_API_KEY=your_key_here npm run start:java-jsp:line
```

## AXPM example project
AXPM 저장소 안에서 구현 저장소를 외부 dependency 로 소비하는 Java 현대화 파이프라인 예제:
```bash
git clone https://github.com/zerotosetta/agentic-task-kit-axpm.git
cd agentic-task-kit-axpm/example-project
npm install
npm run typecheck
npm run start
```
