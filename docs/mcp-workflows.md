# ATK MCP 워크플로 실행

`atk-mcp`는 설정에 등록한 워크플로를 로컬 stdio MCP 도구로 실행합니다. 서버는 작업 등록을 SQLite에 기록한 뒤 실행 ID를 반환하고, 별도 작업 프로세스가 [영속 실행 API](./durable-execution.md)로 작업을 커밋합니다.

```powershell
atk-mcp --config C:/work/atk-mcp.json
```

Node.js로 직접 실행할 때는 설치된 패키지의 `dist/atk-mcp.js`를 지정합니다. Node.js 22.12에서 SQLite를 쓰려면 `node --experimental-sqlite`를 사용합니다. MCP는 초기화가 있는 2025-03-26, 2025-06-18, 2025-11-25 리비전을 지원합니다. 최신 두 리비전의 도구 결과는 `structuredContent`와 JSON 텍스트를 함께 반환합니다. [MCP stdio 사양](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

## 서버 설정과 플러그인

```json
{
  "stateDirectory": "./atk-state",
  "leaseMs": 30000,
  "profiles": {
    "example": {
      "module": "./workflow.mjs",
      "revision": "example-v1",
      "settings": { "prefix": "hello" }
    }
  }
}
```

`stateDirectory`와 `module`의 상대 경로는 설정 파일을 기준으로 해석합니다. 실행별 디렉터리는 `<stateDirectory>/runs/<runId>`입니다. `jobs.sqlite`가 실행 등록과 소유권을, `execution.sqlite`가 체크포인트·시도·산출물 바이트를 보관합니다. 작업 프로세스 로그는 실행 디렉터리의 `worker.log`에 기록합니다.

서버 운영자가 신뢰하는 ESM 파일을 등록합니다. 요청은 등록된 프로필 이름과 그 플러그인이 검증할 JSON 데이터만 전달합니다. 모듈 파일 자체의 해시와 프로필 설정을 실행에 고정합니다. 모듈이 가져오는 의존성과 원문 파일은 해당 워크플로의 리비전과 입력 manifest에서 고정합니다. 프로필에 `maxSteps`를 지정하면 한 번 호출할 때 커밋하는 작업 수를 제한하고, 남은 작업이 있으면 `interrupted`로 반환한 뒤 명시적으로 재개할 수 있습니다.

플러그인의 `createWorkflow({runId, workDirectory, profile, request, store, checkpoint, signal, reportProgress})`은 `{workflow, input, first, prepareNext?}`를 반환합니다. 타입은 패키지의 `McpWorkflowFactory`, `McpWorkflowContext`, `McpWorkflowPlan`에서 가져올 수 있습니다. 기존 플러그인은 추가된 `reportProgress`를 사용하지 않아도 동작합니다.

- `profile`의 필드는 `name`, 정규화한 절대 `module` 경로, `revision`, `settings`, 선택적 `maxSteps`와 `stageOrder`입니다. `workflow.revision`은 등록한 리비전과 같아야 합니다.
- 최초 호출의 `checkpoint`는 `null`입니다. 플러그인이 입력 manifest의 원본 바이트와 입력 산출물을 저장하고 `SnapshotInput`과 첫 작업을 반환합니다. 재개 시에는 같은 작업 디렉터리와 요청으로 팩토리를 다시 호출합니다. 재개 팩토리는 외부 입력의 동일성을 확인하고 현재 체크포인트와 일치하는 `input`을 반환합니다.
- 선택적 `prepareNext({checkpoint, signal})`는 첫 작업 커밋 이후와 재개 진입 시, 다음 작업이 있을 때 호출합니다. 새 입력이 필요하면 `{input, affectedScope, reuseArtifactIds, next}`를 반환합니다. 실행기가 `advanceInput`으로 현재 순번을 비교해 새 세대를 커밋합니다. 전환이 필요 없는 경우에는 `null` 또는 `undefined`를 반환합니다. 재실행 시에도 체크포인트와 커밋된 산출물에서 전환 계획을 다시 계산할 수 있어야 합니다.
- 선택적 `planRerun({checkpoint, request, signal})`는 지정된 단계, 범위, 파라미터를 검증한 뒤 해당 단계의 `DurableWork`를 반환합니다. `request`의 필드는 `id`, `expectedCheckpointSeq`, `stepKey`, `scope`, `params`입니다. 변경된 파라미터가 작업의 동작과 캐시 판정에 반영되도록 다음 작업에 포함합니다. 플러그인이 종료 또는 후속 단계를 결정합니다.
- `workflow`의 작업 콜백은 일반 영속 실행과 동일합니다. 산출물을 결과에 공개하려면 `ctx.putArtifact`로 바이트를 저장하고 반환된 참조를 작업 결과의 `artifacts`에 포함합니다. `outcome`은 플러그인이 정의하며 API가 그대로 보존합니다.

```js
import { createHash } from "node:crypto";

export async function createWorkflow({ runId, profile, request, store, checkpoint, signal }) {
  if (typeof request.name !== "string" || typeof profile.settings?.prefix !== "string") {
    throw new Error("Workflow requires name and a configured prefix.");
  }
  signal.throwIfAborted();
  const bytes = Buffer.from(JSON.stringify({ name: request.name, prefix: profile.settings.prefix }));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (checkpoint && checkpoint.input.sha256 !== sha256) throw new Error("Pinned input differs.");
  const manifest = checkpoint ? null : await store.putArtifact("manifest", bytes);
  const input = checkpoint?.input ?? {
    snapshotId: runId, manifestId: manifest.id, sha256, artifacts: [],
  };

  return {
    input,
    first: { stepKey: "publish", operationKey: "publish", cacheFingerprint: sha256, scope: null },
    workflow: {
      workflowKey: "example",
      revision: profile.revision,
      steps: {
        async publish(ctx) {
          const data = Buffer.from(profile.settings.prefix + " " + request.name);
          const artifact = await ctx.putArtifact("text", data);
          return {
            artifacts: [artifact],
            outcome: { code: "published", detailsRef: artifact.id },
            next: null,
          };
        },
      },
    },
  };
}
```

## MCP 도구

도구는 `tools/list`로 확인하고 `tools/call`로 실행합니다.

| 도구 | arguments | 반환 |
| --- | --- | --- |
| `workflow_start` | `{profile, request, idempotencyKey}` | 작업 완료를 기다리지 않고 `runId`와 현재 상태를 반환합니다. 같은 프로필·키·요청은 기존 실행을 반환합니다. 같은 키에 다른 요청을 전달하면 `IDEMPOTENCY_CONFLICT`가 발생합니다. |
| `workflow_status` | `{runId}` | 기존 실행·체크포인트 필드와 `lastCompletedStep`, `progress`, `lastProgressAt`, `worker`, `nextAction`을 반환합니다. `currentStep`은 다음 작업의 단계이며 도메인 상태는 마지막으로 커밋한 작업 결과에서 가져옵니다. |
| `workflow_progress` | `{runId}` | 현재 단계 키·순번·실행 여부, 최근 작업의 처리량·백분율, 마지막 완료 단계와 진척 시각을 반환하는 읽기 전용 조회입니다. |
| `workflow_resume` | `{runId, expectedCheckpointSeq?, expectedInputSha256?}` | 중단·취소·실패 실행을 다시 예약합니다. 제공한 순번과 입력 해시를 비교하며, 고정 프로필 및 저장된 아티팩트의 무결성을 검증합니다. |
| `workflow_rerun` | `{runId, expectedCheckpointSeq, stepKey, scope?, params?}` | 완료되었거나 실행 중이 아닌 작업에 지정 단계 재실행을 예약합니다. `scope`와 `params`는 JSON 객체입니다. 등록 플러그인의 `planRerun`이 대상과 지원 파라미터를 검사합니다. |
| `workflow_cancel` | `{runId}` | 실행 취소를 저장하고 작업의 `AbortSignal`에 전달합니다. 처리 중인 작업은 콜백이 취소에 응답할 때까지 `running`과 `cancelRequested: true`로 보일 수 있습니다. |
| `workflow_results` | `{runId, artifactId?, cursor?, maxBytes?}` | `artifactId`가 없으면 `{runId, checkpointSeq, artifacts, nextCursor}`를, 있으면 `{runId, checkpointSeq, artifact, offset, totalBytes, data, nextCursor}`를 반환합니다. |

`status` 값의 범위는 `queued`, `running`, `interrupted`, `cancelled`, `failed`, `completed`입니다. 결과의 아티팩트 참조는 `{kind,id,sha256}`이며, 커밋된 아티팩트만 조회할 수 있습니다. 콘텐츠 응답의 `data`는 base64입니다. `maxBytes`는 목록에 대해서는 구조화 JSON 바이트, 콘텐츠에 대해서는 디코딩한 조각 바이트를 제한합니다. 기본값은 65,536이며 최댓값은 262,144입니다. 다음 응답을 받으려면 `nextCursor`를 동일한 실행과 아티팩트 선택으로 전달합니다. 커서는 첫 페이지의 체크포인트에 고정됩니다. 각 콘텐츠 조각에 전체 아티팩트의 동일한 SHA-256이 붙습니다. 도구 오류는 MCP의 `isError`와 `{code,message}`로 전달합니다.

## workflow_progress

`workflow_start`가 반환한 `runId`로 다음 MCP 요청을 보냅니다. 재접속한 클라이언트도 같은 설정과 저장 경로에서 같은 실행을 조회할 수 있습니다. 응답 타입은 패키지에서 `McpWorkflowProgressView`로 가져올 수 있습니다.

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"workflow_progress","arguments":{"runId":"<runId>"}}}
```

다음은 프로필에 일곱 단계를 선언하고 두 번째 단계에서 파일 3개 중 2개를 처리한 경우의 응답 발췌입니다.

```json
{
  "status": "running",
  "stage": { "phase": "executing", "stepKey": "discover", "position": 2, "total": 7 },
  "detail": { "stepKey": "discover", "operation": "analyze-file", "completed": 2, "total": 3, "unit": "files", "item": "page-2.jsp", "sequence": 2, "percent": 66 }
}
```

| 확인할 내용 | 응답 필드와 해석 |
| --- | --- |
| 현재 단계 | `stage.stepKey`는 현재 또는 예약된 단계 키입니다. `stage.phase`가 `executing`이면 현재 체크포인트에서 그 단계의 실행 시도를 확인한 상태입니다. |
| 실행 전후 | `queued`는 작업자 시작 대기, `preparing`은 초기화·계획 또는 다음 시도 준비, `finalizing`은 마지막 커밋 후 종료 상태를 기록하는 구간입니다. `interrupted`, `cancelled`, `failed`, `completed`는 실행 결과입니다. 완료 시 현재 단계 키와 순번은 `null`입니다. |
| 단계 순번 | `stage.position`은 프로필의 `stageOrder`에서 찾은 1부터 시작하는 순번이고 `stage.total`은 선언한 단계 수입니다. 분기·반복·재실행이 있는 경우에도 같은 단계 키는 같은 순번입니다. 선언 밖 단계의 순번, 순서 설정이 없는 실행의 두 값은 `null`입니다. |
| 단계 안의 진척 | `detail`은 최근 `reportProgress` 스냅샷입니다. `operation`, `item`, `message`, `completed`, `total`, `unit`은 플러그인이 제공한 필드만 표시됩니다. `percent`는 해당 작업의 `completed × 100 / total`을 내린 정수입니다. 한쪽 건수가 없거나 전체가 0이면 `null`입니다. |
| 마지막 보고와 생존 여부 | `detail.updatedAt`은 해당 보고 시각, `lastProgressAt`은 단계 진입·커밋 또는 진척 변경 시각, `worker.heartbeatAt`은 작업자의 임대 갱신 시각입니다. 세부 보고가 없으면 `detail`은 `null`이며 단계와 작업자 상태는 계속 조회됩니다. |
| 취소·중단·완료 확인 | `cancelRequested`는 작업자가 취소를 처리하는 동안에도 요청 접수 여부를 보여줍니다. `lastCompletedStep`은 마지막으로 커밋한 단계입니다. 종료 때 남은 `detail`은 마지막 관측값입니다. `error`로 실패 사유를 확인하고 `nextAction`의 도구와 인수를 따릅니다. |

프로필에 순번을 표시하려면 설정 파일의 해당 `profiles` 항목에 다음과 같이 `stageOrder`를 추가합니다.

```json
{
  "module": "./workflow.mjs",
  "revision": "analysis-v1",
  "stageOrder": ["collect", "discover", "parse", "map", "validate", "summarize", "publish"]
}
```

단계 키는 플러그인의 `work.stepKey`와 정확히 일치해야 합니다. 1~256개의 고유한 키를 선언할 수 있고 키당 최대 길이는 256자입니다. 서버가 실행을 처음 등록할 때 순서를 저장하므로 설정 변경은 이후 새 실행부터 반영됩니다. 과거에 순서를 저장하지 않은 실행도 단계 키로 조회할 수 있습니다.

처리 중에는 `nextAction.tool`이 `workflow_progress`인 동안 `retryAfterMs` 후 같은 인수로 다시 조회합니다. 이 도구는 호출 시점의 최신 보고를 반환하므로 두 번 조회하는 사이에 여러 항목이 처리되면 마지막 항목이 보입니다. 파일이나 레코드 단위의 건수를 제공하려면 플러그인의 처리 지점에서 `reportProgress`를 호출합니다. [플러그인 보고 예제](#단계-안의-진척과-생존-신호)

## 재연결과 중단 복구

`workflow_start`는 workflow 완료를 기다리지 않습니다. 클라이언트가 시작 응답을 잃었거나 호스트의 명령 대기가 만료되었으면 같은 설정·프로필·`idempotencyKey`·요청으로 다시 `workflow_start`를 호출합니다. SQLite의 기존 등록을 회수하며 새 실행을 만들지 않습니다. `runId`를 확보한 뒤에는 `workflow_status`와 응답의 `nextAction`으로 관찰합니다. 같은 키에 다른 요청을 보내면 `IDEMPOTENCY_CONFLICT`입니다. 클라이언트의 대기 만료는 작업 취소 또는 worker 종료를 뜻하지 않습니다.

stdio 연결을 닫거나 MCP 서버를 종료해도 분리된 작업 프로세스는 계속 실행합니다. 동일한 설정과 저장 경로로 서버를 다시 열고 `workflow_status`나 `workflow_results`를 사용합니다. 작업 프로세스 자체가 종료되면 임대가 만료된 뒤 마지막 체크포인트에서 `workflow_resume`으로 계속할 수 있습니다. 시작 과정에서 작업 프로세스를 실행하기 전에 서버가 사라진 경우에는 큐 만료 후 명시적으로 재개할 수 있습니다. 큐 기본 대기 시간은 10초와 실행 임대 중 큰 값이며, 설정의 `queueMs`로 지정할 수 있습니다.

`notifications/cancelled`는 JSON-RPC 요청의 응답 대기만 취소합니다. 실행을 취소하려면 `workflow_cancel`을 호출하고 상태를 확인합니다. 커밋 경계에 도달한 작업의 결과는 상태와 결과 조회에 그대로 남을 수 있습니다. 콜백은 신호를 외부 작업에 전달하고 실행을 양보해야 합니다. 프로세스 재시작으로 재시도될 수 있는 외부 쓰기는 논리 작업 키로 멱등 처리합니다. SQLite 파일은 잠금을 지원하는 로컬 파일시스템에 보관합니다.

재실행 요청은 `workflow_status`에서 계획 커밋 전에는 `pendingRerun`으로, 커밋 뒤에는 `rerun`으로 조회합니다. ATK는 동일한 입력 세대에서 기존 헤드 순번을 비교해 새 체크포인트를 공개합니다. 체크포인트의 `rerun`에 요청과 파라미터가, `next`에 플러그인이 정한 실제 작업 범위가 저장됩니다. 마지막 요청의 동일한 재전송은 기존 실행 상태를 반환합니다. 작업 프로세스가 중단돼도 `workflow_resume`으로 미적용 요청 또는 커밋된 다음 작업을 재개할 수 있습니다.

## 단계 안의 진척과 생존 신호

다음은 `workflow_status`의 필드입니다. 현재 단계의 선언된 순번은 `workflow_progress`의 `stage.position`에서 확인합니다. 플러그인이 마지막으로 완료한 단계의 결과는 `lastCompletedStep.outcome`에 있습니다. `checkpointSeq`는 입력 전환·재실행 계획 커밋을 포함한 체크포인트 순번입니다.

| 필드 | 의미 |
| --- | --- |
| `lastCompletedStep` | 마지막 작업 커밋의 `{stepKey, checkpointSeq, generation, outcome}` 또는 `null`. 입력 전환 뒤에도 직전 실제 작업을 가리킵니다. |
| `currentStep` | 현재 헤드가 예약한 단계 또는 재실행을 요청한 단계. 실제 실행 시도의 시작 여부는 `workflow_progress`의 `stage.phase`로 확인합니다. |
| `progress` | 현재 작업의 플러그인 진척. `attemptId`, `stepKey`, 선택적 `operation`, `completed`, `total`, `unit`, `item`, `message`와 ATK가 기록한 `sequence`, `updatedAt`, `generation`, `checkpointSeq`. 보고하지 않은 플러그인은 `null`입니다. |
| `lastProgressAt` | 단계 진입·커밋 또는 변경된 진척 보고 시각. 같은 값의 재보고와 heartbeat는 갱신하지 않습니다. |
| `worker` | `{state, pid, startedAt, heartbeatAt, leaseExpiresAt}`. state는 `starting`, `alive`, `expired`, `stopped`입니다. heartbeat는 임대 갱신을 뜻하며 파일 분석·업무 처리 완료의 증거가 아닙니다. |
| `nextAction` | `{action, tool, arguments, reason, retryAfterMs?}`. 클라이언트가 다음에 수행할 행동 하나를 안내합니다. |

활성 실행의 `nextAction.action`은 `status`이며 같은 runId의 `workflow_status`를 안내합니다. heartbeat만 갱신되고 `lastProgressAt`이 오래됐으면 생존과 진척을 구분해 표시합니다. 정체 판단·운영 timeout은 호스트 정책이며 진척이 잠시 없다는 이유로 자동 취소·새 실행을 만들지 않습니다.

부모 서버가 직접 관측한 worker 종료는 `WORKER_EXITED`로 기록합니다. 부모 연결 없이 임대가 만료된 경우는 `WORKER_LEASE_EXPIRED`이며, OS 프로세스의 사망을 확정하는 표현이 아닙니다. durable 실행 임대가 남아 있으면 상태 조회를 안내하고, 재개 가능한 중단 상태에서만 `workflow_resume`을 안내합니다. 정상 완료 후의 `worker.state: stopped`는 장애가 아닙니다.

플러그인은 팩토리에서 받은 콜백에 현재 단계 컨텍스트의 `attemptId`와 `work.stepKey`를 전달합니다. 외부 이벤트 콜백에 연결할 때도 이 값을 해당 시도에서 캡처합니다. 현재 단계와 다른 stepKey나 잘못된 건수는 오류이며, 종료되거나 소유권을 잃은 시도의 늦은 보고는 반영하지 않습니다. 작업 경계에서 이전 단계의 파일 진척은 초기화되며, 보고는 체크포인트나 복구용 산출물을 대체하지 않습니다. 진척 sequence와 마지막 진척 시각은 같은 runId의 재개·재실행에도 유지됩니다.

```js
export async function createWorkflow({ reportProgress, profile /* 기존 입력 등 */ }) {
  // 기존 input, first를 준비합니다.
  return {
    input, first,
    workflow: {
      workflowKey: "file-analysis", revision: profile.revision,
      steps: {
        async discover(ctx) {
          const files = await listInputFiles(ctx);
          for (let index = 0; index < files.length; index++) {
            ctx.signal.throwIfAborted();
            await analyzeOneFile(files[index], ctx.signal);
            reportProgress({
              attemptId: ctx.attemptId, stepKey: ctx.work.stepKey, operation: "analyze-file",
              completed: index + 1, total: files.length, unit: "files",
              item: files[index].relativePath,
            });
          }
          return { outcome: { code: "discovered", fileCount: files.length }, next: null };
        },
      },
    },
  };
}
```

`operation`과 `item`은 플러그인이 선택하는 요약 식별자입니다. 원문 본문·인증정보·민감한 절대경로를 진척 메시지에 넣지 않습니다. 기존 데이터베이스는 telemetry 열을 추가하는 방식으로 열며, 과거 체크포인트를 다시 쓰지 않습니다.

## 원인 오류와 복구 가능 여부

기존 오류의 `code`와 `message`는 유지합니다. 단계 오류는 여전히 `STEP_FAILED`로 보일 수 있고, 플러그인의 원래 `{code, message, recoverable?}`는 `error.cause`에 보존합니다. 팩토리나 worker 자체 오류도 같은 제한된 필드로 전달하며 stack·임의 오류 객체 전체를 직렬화하지 않습니다.

```js
throw Object.assign(new Error("The pinned input must be restored by the operator."), {
  code: "INPUT_RESTORE_UNAVAILABLE", recoverable: false,
});
```

명시적 `recoverable: false`는 `nextAction.action: inspect`로 안내하고 재개를 거부합니다. 복구 가능 여부가 없는 일반 실패도 우선 inspect를 안내하지만, 운영자가 원인을 점검한 뒤 명시적으로 재개할 수 있습니다. 관측된 worker 종료·임대 만료와 플러그인의 복구 불가 오류를 같은 재시도 정책으로 처리하지 않습니다.
