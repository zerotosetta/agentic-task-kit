# Consumer Example

이 문서는 라이브러리 소비자가 직접 workflow 를 정의하고 실행하는 가장 작은 예제를 설명한다.

## 실행
```bash
npm run example:consumer
```

line mode 로 확인하려면:
```bash
CYCLE_LIVE=0 npm run example:consumer
```

## 예제에서 보여주는 것
- `Task` 클래스를 상속해 workflow task 를 직접 구현하는 방법
- `WorkflowDefinition` 으로 상태 전이와 종료 지점을 정의하는 방법
- `createCycle()` 에 renderer, memory store, artifact store 를 조합하는 방법
- task 내부에서 `ctx.log`, `ctx.memory`, `ctx.artifacts` 를 사용하는 방법

## 흐름
1. `captureRequest` 가 입력을 workflow memory 에 저장한다.
2. `draftPlan` 이 memory 를 읽어 action plan artifact 를 만든다.
3. renderer 가 실행 상태와 task log 를 CLI 로 출력한다.

## 참고 파일
- runnable script: [run-consumer-example.ts](../scripts/run-consumer-example.ts)
- baseline sample workflow: [report-workflow.ts](../src/examples/report-workflow.ts)
