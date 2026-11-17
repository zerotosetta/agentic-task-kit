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

플러그인의 `createWorkflow({runId, workDirectory, profile, request, store, checkpoint, signal})`은 `{workflow, input, first, prepareNext?}`를 반환합니다. 타입은 패키지의 `McpWorkflowFactory`, `McpWorkflowContext`, `McpWorkflowPlan`에서 가져올 수 있습니다.

- `profile`의 필드는 `name`, 정규화한 절대 `module` 경로, `revision`, `settings`, 선택적 `maxSteps`입니다. `workflow.revision`은 등록한 리비전과 같아야 합니다.
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
| `workflow_status` | `{runId}` | `runId`, `profile`, `status`, `checkpointSeq`, `generation`, `currentStep`, `domainStatus`, `outcome`, `inputSha256`, `error`, `cancelRequested`를 반환합니다. `currentStep`은 다음 작업의 단계이며 도메인 상태는 마지막으로 커밋한 작업 결과에서 가져옵니다. |
| `workflow_resume` | `{runId, expectedCheckpointSeq?, expectedInputSha256?}` | 중단·취소·실패 실행을 다시 예약합니다. 제공한 순번과 입력 해시를 비교하며, 고정 프로필 및 저장된 아티팩트의 무결성을 검증합니다. |
| `workflow_rerun` | `{runId, expectedCheckpointSeq, stepKey, scope?, params?}` | 완료되었거나 실행 중이 아닌 작업에 지정 단계 재실행을 예약합니다. `scope`와 `params`는 JSON 객체입니다. 등록 플러그인의 `planRerun`이 대상과 지원 파라미터를 검사합니다. |
| `workflow_cancel` | `{runId}` | 실행 취소를 저장하고 작업의 `AbortSignal`에 전달합니다. 처리 중인 작업은 콜백이 취소에 응답할 때까지 `running`과 `cancelRequested: true`로 보일 수 있습니다. |
| `workflow_results` | `{runId, artifactId?, cursor?, maxBytes?}` | `artifactId`가 없으면 `{runId, checkpointSeq, artifacts, nextCursor}`를, 있으면 `{runId, checkpointSeq, artifact, offset, totalBytes, data, nextCursor}`를 반환합니다. |

`status` 값의 범위는 `queued`, `running`, `interrupted`, `cancelled`, `failed`, `completed`입니다. 결과의 아티팩트 참조는 `{kind,id,sha256}`이며, 커밋된 아티팩트만 조회할 수 있습니다. 콘텐츠 응답의 `data`는 base64입니다. `maxBytes`는 목록에 대해서는 구조화 JSON 바이트, 콘텐츠에 대해서는 디코딩한 조각 바이트를 제한합니다. 기본값은 65,536이며 최댓값은 262,144입니다. 다음 응답을 받으려면 `nextCursor`를 동일한 실행과 아티팩트 선택으로 전달합니다. 커서는 첫 페이지의 체크포인트에 고정됩니다. 각 콘텐츠 조각에 전체 아티팩트의 동일한 SHA-256이 붙습니다. 도구 오류는 MCP의 `isError`와 `{code,message}`로 전달합니다.

## 재연결과 중단 복구

stdio 연결을 닫거나 MCP 서버를 종료해도 분리된 작업 프로세스는 계속 실행합니다. 동일한 설정과 저장 경로로 서버를 다시 열고 `workflow_status`나 `workflow_results`를 사용합니다. 작업 프로세스 자체가 종료되면 임대가 만료된 뒤 마지막 체크포인트에서 `workflow_resume`으로 계속할 수 있습니다. 시작 과정에서 작업 프로세스를 실행하기 전에 서버가 사라진 경우에는 큐 만료 후 명시적으로 재개할 수 있습니다. 큐 기본 대기 시간은 10초와 실행 임대 중 큰 값이며, 설정의 `queueMs`로 지정할 수 있습니다.

`notifications/cancelled`는 JSON-RPC 요청의 응답 대기만 취소합니다. 실행을 취소하려면 `workflow_cancel`을 호출하고 상태를 확인합니다. 커밋 경계에 도달한 작업의 결과는 상태와 결과 조회에 그대로 남을 수 있습니다. 콜백은 신호를 외부 작업에 전달하고 실행을 양보해야 합니다. 프로세스 재시작으로 재시도될 수 있는 외부 쓰기는 논리 작업 키로 멱등 처리합니다. SQLite 파일은 잠금을 지원하는 로컬 파일시스템에 보관합니다.

재실행 요청은 `workflow_status`에서 계획 커밋 전에는 `pendingRerun`으로, 커밋 뒤에는 `rerun`으로 조회합니다. ATK는 동일한 입력 세대에서 기존 헤드 순번을 비교해 새 체크포인트를 공개합니다. 체크포인트의 `rerun`에 요청과 파라미터가, `next`에 플러그인이 정한 실제 작업 범위가 저장됩니다. 마지막 요청의 동일한 재전송은 기존 실행 상태를 반환합니다. 작업 프로세스가 중단돼도 `workflow_resume`으로 미적용 요청 또는 커밋된 다음 작업을 재개할 수 있습니다.
