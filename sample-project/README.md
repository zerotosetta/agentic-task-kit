# Sample Project

이 샘플 프로젝트는 `agentic-task-kit` 라이브러리를 로컬 file dependency 로 연결해서 사용하는 예제다.
OpenAI-compatible config file, default headers, optional streaming workflow 를 함께 보여준다.

## 구조
- 설정 파일: [cycle.config.json](/Users/fortrit/workspace/agentic-task-kit/agentic-task-kit/sample-project/cycle.config.json)
- 진입점: [main.ts](/Users/fortrit/workspace/agentic-task-kit/agentic-task-kit/sample-project/src/main.ts)

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

streaming workflow:
```bash
OPENAI_API_KEY=your_key_here CYCLE_STREAM=1 npm run start
```

line mode:
```bash
OPENAI_API_KEY=your_key_here npm run start:line
```

Ink TUI mode:
```bash
OPENAI_API_KEY=your_key_here CYCLE_RENDER_MODE=ink npm run start
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
OPENAI_API_KEY=your_key_here OPENAI_HTTP_DEBUG=1 CYCLE_RENDER_MODE=ink npm run start
```
