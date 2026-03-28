# Sample Project

이 샘플 프로젝트는 `agentic-task-kit` 라이브러리를 로컬 file dependency 로 연결해서 사용하는 예제다.

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

line mode:
```bash
OPENAI_API_KEY=your_key_here npm run start:line
```

다른 설정 파일 지정:
```bash
OPENAI_API_KEY=your_key_here CYCLE_OPENAI_CONFIG_PATH=./cycle.config.json npm run start
```
