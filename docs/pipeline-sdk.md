# ATK 파이프라인 SDK

파이프라인을 ESM 모듈 하나에 정의해 Node.js에서 직접 실행하거나 독립 stdio MCP 서버에 등록할 수 있습니다. Node.js 22.12에서 SQLite에 접근할 때는 `--experimental-sqlite`가 필요합니다. 샘플은 로컬 처리, 별도 MCP 프로세스 호출, 결과 발행까지 수행합니다.

## 새 프로젝트 실행

로컬 배포본을 사용할 때는 새 상위 폴더에서 다음 명령을 실행합니다. PowerShell 예시의 첫 줄에는 받은 tgz 파일의 실제 경로를 지정합니다.

```powershell
$packageFile = (Resolve-Path .\agentic-task-kit-0.2.0-sdk.2.tgz).Path
npm install $packageFile
npx --no-install atk-mcp init .\word-demo
cd .\word-demo
npm install $packageFile
npm run setup
npm run local -- one two three
```

`local`은 `{"report":"Words: 3"}`와 실행 ID를 출력합니다. `init`은 빈 폴더에 파일을 생성합니다. `setup`은 세 프로필의 descriptor에서 최초 `atk-mcp.json`을 만듭니다. 설정이 이미 있으면 기존 파일을 보존하고 종료합니다. 워크플로의 공개 스키마를 수정하면 해당 설정도 함께 갱신합니다.

MCP 호스트의 서버 실행 명령으로 `node`, 인수로 프로젝트의 `node_modules/agentic-task-kit/dist/atk-mcp.js`, `--config`, `atk-mcp.json`의 **절대경로**를 지정합니다. 서버에서 `workflow_list({})`로 프로필을 찾고 `workflow_describe({profile:"word-report"})`로 입력 규격을 확인합니다. `workflow_start`의 인수 예시는 다음과 같습니다.

```json
{ "profile": "word-report", "request": { "text": "one two three" }, "idempotencyKey": "report-001" }
```

`runId`로 `workflow_progress`를 조회합니다. 완료 후 `lastCompletedStep.outcome.detailsRef`가 최종 JSON 산출물 ID입니다. 다른 MCP 연결에서도 같은 저장 경로와 실행 ID로 조회할 수 있습니다. 기존 프로필은 예전 설정 그대로 등록되며, 스키마를 선언한 프로필의 잘못된 요청은 작업 등록 전에 거부됩니다. [도구별 호출과 진행률](./mcp-workflows.md)

## 단계 작성과 실행

`definePipeline`은 단계 목록 순서대로 처리하고 이전 단계 출력을 다음 입력으로 전달합니다. `selectInput(previous, ctx)`으로 원래 요청과 앞 단계 출력을 조합할 수 있습니다. TypeScript의 `defineStep`과 `defineOperation`은 리터럴 스키마로 핸들러의 입력 필드와 반환 타입을 추론합니다.

```ts
import { definePipeline, defineStep } from "agentic-task-kit";

const text = {
  type: "object", properties: { text: { type: "string" } },
  required: ["text"], additionalProperties: false,
} as const;
const uppercase = defineStep({
  key: "uppercase", inputSchema: text, outputSchema: text,
  run: ({ text }) => ({ text: text.toUpperCase() }),
});
export const pipeline = definePipeline({
  key: "label", description: "Convert a label to uppercase", revision: "1",
  inputSchema: text, outputSchema: text, steps: [uppercase],
});
export const { descriptor, createWorkflow } = pipeline;
```

로컬 호출 애플리케이션은 모듈의 정의를 가져와 실행합니다.

```ts
import { runPipeline } from "agentic-task-kit";
import { pipeline } from "./workflow.js";
const result = await runPipeline(pipeline, { text: "atk" }, { stateDirectory: "./local-state" });
```

지원하는 스키마 키는 `type`, `description`, `properties`, `required`, 불리언 `additionalProperties`, `items`, `enum`입니다. 선언 시 지원 키를 확인하고 실행 시 요청, 단계 입력·출력, 최종 출력을 검증합니다. MCP 프로필의 요청은 객체여야 합니다. 핸들러나 가져온 모듈의 동작이 달라지면 애플리케이션이 `revision`을 올립니다. 추가 규칙 데이터는 `rules`로 고정할 수 있습니다.

| 작성 기능 | 동작 |
| --- | --- |
| 조건 분기·반복 | `next(output, ctx)`가 다음 단계 키 또는 종료를 뜻하는 `null`을 반환합니다. `maxTransitions`는 한 경로의 전이 횟수를 제한합니다. |
| 일시 중단·자료 대기 | `pauseAfter: true`는 현재 단계를 커밋한 뒤 멈춥니다. `waitUntil(ctx)`가 거짓이면 대상 단계를 실행하지 않고 같은 체크포인트에서 대기합니다. 자료가 준비된 뒤 명시적으로 재개합니다. |
| 재개·선택 재실행 | 로컬은 같은 요청으로 `runPipeline(pipeline, request, {stateDirectory, runId, resume:true, expectedCheckpointSeq})`를 호출합니다. MCP는 `workflow_resume`과 `workflow_rerun`을 사용합니다. 재실행은 선택한 경로의 입력에서 시작하며 단계는 `ctx.rerun`에서 범위와 매개변수를 읽습니다. |
| 병렬 합류 | `parallelStep({key, inputSchema, branches:[{key, pipeline}, …], concurrency:2})`는 자식 파이프라인을 제한된 동시성으로 실행합니다. 모두 성공하면 분기 키별 출력을 반환합니다. 실패나 대기 후 부모를 재개하면 완료한 자식 결과를 재사용합니다. 새 단계 재실행은 새 자식 실행을 만듭니다. 복구할 때는 부모 작업 폴더의 `parallel` 상태도 보존합니다. |
| 진척·외부 작업 | `ctx.reportProgress({operation,completed,total,unit,item})`은 현재 시도와 단계에 묶입니다. 외부 쓰기는 `runId`와 논리 작업 키 `ctx.operationKey`를 멱등 키로 사용할 수 있습니다. 작업자가 쓰기를 끝내고 체크포인트를 커밋하기 전에 종료되면 같은 작업이 재시도될 수 있습니다. |

## 도메인 체크포인트를 사용하는 단계

기존 업무가 단계별 상태, 여러 산출물, 입력 스냅샷을 관리한다면 `definePipeline({ mode: "durable", … })`로 그 계약을 선언할 수 있습니다. 예를 들어 검증을 마친 보고서를 발행하는 단계는 다음처럼 작성합니다.

```ts
const publish = {
  key: "publish",
  inputSchema: publishScopeSchema,
  outputSchema: publicationOutcomeSchema,
  allowedNext: [null],
  async run(ctx: DurableStepContext) {
    const report = await renderVerifiedReport(ctx);
    const artifact = await ctx.putArtifact("business-report", report);
    return {
      next: null, artifacts: [artifact],
      outcome: { code: "verified-and-published", reportId: artifact.id },
    };
  },
};

const pipeline = definePipeline({
  mode: "durable", key: "reports", revision, description: "검증된 보고서 발행",
  inputSchema: requestSchema, outputSchema: publicationOutcomeSchema,
  steps: [verify, publish],
  bind: (host, fingerprint) => bindReportRun(host, fingerprint),
});
```

`bind`는 실행마다 `{ input, first }`를 반환합니다. `input`은 도메인의 입력 스냅샷이고 `first`는 최초 `DurableWork`입니다. 도메인이 manifest에 선언 지문 `fingerprint`와 입력 식별 정보를 저장하고, 재개할 때 현재 값과 대조합니다. 핸들러의 동작 변경은 `revision`에 반영합니다.

SDK는 실행 요청, 단계의 `work.scope`, 커밋할 `outcome`, 다음 단계의 키와 입력을 검증합니다. 각 단계가 허용하는 다음 키를 `allowedNext`에 지정하고, 종료할 수 있는 단계에는 `null`을 포함합니다. 종료 시 파이프라인의 출력 스키마도 검사합니다. 커밋에는 핸들러가 반환한 결과 코드와 산출물 참조가 보존됩니다. 로컬에서는 `result.checkpoint.committed`, MCP에서는 `workflow_progress`의 `lastCompletedStep`과 `workflow_results`로 확인할 수 있습니다.

`bind`에서 `prepareNext`로 입력 세대와 재사용할 산출물을 함께 전환하고, `pauseBefore`로 자료 제출을 기다리고, `planRerun`으로 선택 재실행을 구성할 수 있습니다. 실행기가 사용하는 내부 제어 단계에는 `internal: true`를 지정합니다. 진행률의 단계 번호와 전체 단계 수에는 공개 단계만 들어갑니다. [체크포인트와 입력 세대](./durable-execution.md)

## 에이전트가 목표로부터 계획 만들기

스타터의 `agent.mjs`는 `createAgentPipeline`에 목표·입출력 스키마와 작업 카탈로그를 제공합니다. 작업에는 키, 리비전, 설명, 입출력 스키마, 효과(`read`, `write`, `external`), 호스트가 작성한 핸들러를 지정합니다. 기본 허용 효과는 `read`입니다. 허용 효과를 넓히려면 호스트에서 `allowedEffects`를 명시합니다. 외부 도구의 명령과 접속 정보는 작업 핸들러가 관리합니다.

- **서버 모델이 계획을 구성할 때**는 서버 환경변수 `ATK_PLANNER_CONFIG`에 ATK 모델 설정 파일의 절대경로를 지정하고 `planned-report`를 시작합니다. 요청 예시는 `{"goal":"단어 수를 세어 짧은 보고서를 작성해","text":"one two three"}`입니다. ATK가 모델에 허용 작업과 계약을 전달하고, 계획 오류가 있으면 한도 안에서 수정 기회를 줍니다. 기본 계획 예산은 최대 16단계, 모델 응답은 최대 2회입니다. [모델 설정](./ai-api.md)
- **외부 MCP 호스트의 에이전트가 구성할 때**는 `workflow_describe({profile:"submitted-report"})`에서 카탈로그와 계획 형식을 읽고, 같은 프로필의 `workflow_start`에 아래 요청을 제출합니다. 서버 측 모델 설정 없이 동작합니다. 응용 프로그램에서는 `agent.fromPlan.createWorkflow`로 이 프로필을 등록합니다.
- **애플리케이션에서 먼저 계획을 검토할 때**는 `planPipeline(options, request)`로 계획을 생성하거나 `validatePipelinePlan(candidate, options)`로 검증할 수 있습니다. 호스트의 기존 플래너를 사용하려면 `aiProvider` 대신 `planner(context)`를 지정합니다.

```json
{
  "input": { "goal": "단어 수 보고서", "text": "one two three" },
  "plan": {
    "steps": [
      { "id": "measure", "operation": "count_words", "args": { "text": { "from": "request", "path": ["text"] } } },
      { "id": "render", "operation": "format", "args": { "count": { "from": "step", "step": "measure", "path": ["count"] } } }
    ],
    "result": { "from": "step", "step": "render" }
  }
}
```

실행 전 전체 계획을 검사합니다. 작업의 존재와 허용 효과, 단계 ID의 유일성, 선행 단계 참조, 필수 인수, 타입 호환성, 최종 결과 스키마, 크기와 단계 수 한도가 검증 대상입니다. `{"value": …}`로 상수도 전달할 수 있습니다. 생성한 계획은 등록 작업의 유한한 순서와 데이터 연결을 표현합니다. 조건 분기와 병렬 처리가 필요한 작업은 호스트에서 해당 파이프라인을 구성합니다. 최초 체크포인트에 승인된 계획과 입력·작업 계약을 고정합니다. 그 시점 이후의 재개는 모델을 다시 호출하지 않습니다. 최초 체크포인트를 저장하기 전에 종료하면 계획 요청이 다시 수행될 수 있습니다.

## 다른 MCP 서버와 연결하기

에이전트 실행에서 첫 단계가 커밋된 뒤에는 `workflow_results({runId})`에 `pipeline-plan` 산출물이 표시됩니다. 이 산출물로 승인된 단계·인수 연결·작업별 고정 리비전을 확인할 수 있습니다. 로컬 저장소에서는 `readPinnedPipelineRules(store, checkpoint)`로 최초 체크포인트부터 계획 규칙을 조회할 수 있습니다.

스타터의 `word-service.mjs`는 `serveMcpTools`로 JSON 도구를 별도 stdio 서버에 공개합니다. `operations.mjs`는 `connectMcpClient`로 그 프로세스를 시작해 `callToolValue`로 결과값을 읽고 `finally`에서 닫습니다. `listTools`는 여러 페이지의 도구를 수집하고, `callTool`은 콘텐츠와 구조화 응답을 보존합니다. `readWorkflowArtifact(runId, ref)`는 내려받은 조각의 순서·길이·SHA-256을 검증합니다.

기존 MCP 서버에 ATK를 넣으려면 `const atk = openWorkflowTools(configPath)`로 등록된 프로필을 엽니다. 호스트의 도구 목록에 `atk.listTools()`의 항목을 등록하고, 해당 이름의 호출을 `atk.callTool(name, args, signal)`로 전달합니다. 서버가 종료될 때 `atk.close()`를 호출합니다. 독립 실행기의 전송 방식은 stdio이며 임베딩 시 전송과 접속 인증은 호스트가 담당합니다.

호스트가 ATK 코드를 자체 번들에 합치면 `openWorkflowTools(configPath, {workerEntry: "/absolute/path/to/agentic-task-kit/dist/atk-mcp.js"})`처럼 실제 배포한 워커 CLI 절대경로를 지정합니다. 표준 패키지 설치에서는 SDK와 같은 폴더의 CLI를 자동으로 사용합니다.
