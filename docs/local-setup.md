# Local Setup

## Requirements
- Node.js 22.12+
- npm 10+

## Windows / PowerShell
Windows 에서도 Node.js 22.12+ 와 npm 을 사용한다. PowerShell 실행 정책 때문에 `npm.ps1` 이 차단되는 환경은 `npm.cmd` 로 실행하면 된다. 실행 정책 변경이나 WSL 은 필요하지 않다.

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run build:all-in-one
npm.cmd run test:package
npm.cmd run test:package -- .npm-package/dist
```

PowerShell 에서는 `NAME=value command` 대신 `$env:NAME = "value"` 를 사용한다. 아래 Bash 예제의 환경변수도 같은 방식으로 설정한다.

```powershell
$env:CYCLE_RENDER_MODE = "ink"
npm.cmd run example
Remove-Item Env:CYCLE_RENDER_MODE

Set-Location sample-project
npm.cmd ci
npm.cmd run start:sub:line
npm.cmd run start:sub:ink

$env:GEMINI_API_KEY = "your_key_here"
npm.cmd run start:java-jsp:line
Remove-Item Env:GEMINI_API_KEY
```

sample 의 `start:*` npm scripts 는 `cross-env` 를 사용하므로 Windows 기본 `cmd.exe` 와 POSIX shell 양쪽에서 실행할 수 있다. 키가 필요한 예제는 해당 provider 설정을 먼저 준비한다.

Ink 는 interactive TTY 에서 동작한다. `q` 는 실행 중인 workflow 를 취소한 뒤 code 0, 실행 중 `Ctrl+C` 는 취소 후 code 130, idle `Ctrl+C` 는 code 0 으로 종료한다. Windows 는 terminal 복구 후 `process.exitCode` 와 stdin pause/unref 로 비동기 정리를 마치고 종료하며, 호스트가 별도로 시작한 server/timer 의 정리는 호스트가 담당한다. non-TTY 에서는 `jsonl` 로 fallback 한다.

검증 환경과 상세 결과는 PM 레포의 `dialog/2026-11-02.md` 에 기록한다.

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
node -e "import('./dist/index.js')"
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
