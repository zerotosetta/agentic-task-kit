# Local Setup

## Requirements
- Node.js 22+
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
`Tab`, `↑↓`, `j k`, `PageUp/PageDown`, `Home/End`, `g/G` 를 지원한다.
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

## Workspace root example project
workspace root 에서 구현 저장소를 외부 dependency 로 소비하는 Java 현대화 파이프라인 예제:
```bash
cd /Users/fortrit/workspace/agentic-task-kit/example-project
npm install
npm run typecheck
npm run start
```
