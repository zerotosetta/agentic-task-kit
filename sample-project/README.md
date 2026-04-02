# Sample Project

이 샘플 프로젝트는 `agentic-task-kit` 라이브러리를 로컬 file dependency 로 연결해서 사용하는 예제다.
OpenAI-compatible config file, default headers, non-stream workflow, streaming workflow 를 각각 별도 진입점으로 보여준다.

## 구조
- 설정 파일: [cycle.config.json](./cycle.config.json)
- 진입점: [main.ts](./src/main.ts)

## 설치
```bash
cd sample-project
npm install
```

## 실행
기본 설정 파일 사용:
```bash
OPENAI_API_KEY=your_key_here npm run start
```

Ink TUI mode:
```bash
OPENAI_API_KEY=your_key_here CYCLE_RENDER_MODE=ink npm run start
```

sub workflow example:
```bash
npm run start:sub
```

sub workflow example in line mode:
```bash
npm run start:sub:line
```

sub workflow example in Ink mode:
```bash
npm run start:sub:ink
```

streaming workflow:
```bash
OPENAI_API_KEY=your_key_here npm run start:stream
```

line mode:
```bash
OPENAI_API_KEY=your_key_here npm run start:line
```

다른 설정 파일 지정:
```bash
OPENAI_API_KEY=your_key_here CYCLE_OPENAI_CONFIG_PATH=./cycle.config.json npm run start
```

요청 단위 headers 지정:
```bash
OPENAI_API_KEY=your_key_here \
CYCLE_REQUEST_HEADERS_JSON='{"X-Request-ID":"sample-project-run"}' \
npm run start
```

HTTP debug 로그 활성화:
```bash
OPENAI_API_KEY=your_key_here OPENAI_HTTP_DEBUG=1 npm run start
```

Ink TUI 에서 provider debug 로그까지 우측 패널에 함께 보려면:
```bash
OPENAI_API_KEY=your_key_here OPENAI_HTTP_DEBUG=1 CYCLE_LOG_LEVEL=debug CYCLE_RENDER_MODE=ink npm run start
```

## Sub Workflow Example
`src/main-sub-workflow.ts` 는 parent workflow 가 `ctx.runSubWorkflow()` 로 child workflow 를 branch 로 호출하는 예제다.

- parent workflow: `release-orchestration`
- child workflow: `service-analysis`
- branch id: `branch.service-analysis`

Ink mode 에서는 parent 아래에 child workflow branch 가 이어서 렌더링되고, 각 task box 에 task 이름과 소요시간이 함께 표시된다. workflow 실행이 끝난 뒤에도 Ink 세션은 유지되며, `Ctrl+C` 입력이 들어오면 터미널 출력을 오염시키지 않게 Ink session 을 닫고 프로세스를 종료한다.
