# 영속 실행과 체크포인트 재개

`runDurable`은 호출자가 등록한 작업을 순서대로 실행합니다. 작업은 결과 코드와 다음 작업을 반환합니다. ATK는 산출물 바이트를 먼저 저장하고, 작업 결과·시도 기록·다음 작업을 단일 SQLite 트랜잭션으로 공개합니다. 실행 ID와 SQLite 파일이 있으면 다른 프로세스에서 마지막으로 커밋된 다음 작업을 시작할 수 있습니다.

예제의 첫 실행은 검증 결과와 대상 파일을 커밋한 뒤 멈춥니다. 재개 프로세스는 같은 정의와 입력으로 영향 범위의 정적 작업만 실행합니다.

```ts
import { createHash } from "node:crypto";
import {
  SqliteDurableExecutionStore,
  getCheckpoint,
  resumeDurable,
  runDurable,
  type DurableWorkflow,
} from "agentic-task-kit";

const database = "./analysis.sqlite";
const runId = "fixture-001";
const scope = { sourcePaths: ["/fixture/affected.jsp"] };
const rules = "static-v2";
const fingerprint = (...parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const workflow: DurableWorkflow = {
  workflowKey: "analysis",
  revision: rules,
  steps: {
    async verify({ putArtifact, checkpoint }) {
      const evidence = await putArtifact("verification", Buffer.from("repair-needed"));
      return {
        artifacts: [evidence],
        outcome: { code: "repair-needed", detailsRef: evidence.id, coverage: { complete: false } },
        next: {
          stepKey: "static",
          operationKey: "static:repair-2",
          scope,
          cacheFingerprint: fingerprint(rules, checkpoint.input.sha256, JSON.stringify(scope)),
        },
      };
    },
    static: ({ work }) => ({ outcome: { code: "repaired", scope: work.scope }, next: null }),
  },
};

async function start() {
  const store = new SqliteDurableExecutionStore(database);
  try {
    const manifest = await store.putArtifact("manifest", Buffer.from('{"snapshot":"s1"}'));
    const input = { snapshotId: "s1", manifestId: manifest.id, sha256: manifest.sha256, artifacts: [] };
    const result = await runDurable(workflow, {
      store, runId, input, maxSteps: 1,
      first: {
        stepKey: "verify",
        operationKey: "verify:1",
        scope,
        cacheFingerprint: fingerprint(rules, input.sha256, JSON.stringify(scope)),
      },
    });
    // status: "interrupted", checkpointSeq: 1, next.operationKey: "static:repair-2"
    return result;
  } finally {
    store.close();
  }
}

async function resume() {
  const store = new SqliteDurableExecutionStore(database);
  try {
    const head = await getCheckpoint(runId, { store });
    if (!head) throw new Error("Missing run.");
    const result = await resumeDurable(runId, {
      store, workflow,
      expectedCheckpointSeq: head.checkpointSeq,
      // The fixture pins the original saved snapshot. A real caller prepares and pins its expected input.
      expectedInput: head.input,
    });
    // status: "completed", checkpointSeq: 2, committed.outcome.code: "repaired"
    return result;
  } finally {
    store.close();
  }
}

if (process.argv[2] === "resume") await resume();
else await start();
```

## 저장과 조회

- `runDurable(workflow, {store, input, first, runId?, signal?, maxSteps?})`는 0번 체크포인트를 생성합니다. 재개할 프로세스에서 바로 조회할 수 있게 최초 실행의 ID를 지정할 수 있습니다.
- `resumeDurable(runId, {store, workflow, expectedInput, expectedCheckpointSeq?, signal?, maxSteps?})`는 워크플로 키·리비전, 고정된 manifest와 입력 참조, 현재 세대의 아티팩트 바이트를 검증합니다. `SnapshotInput`의 `sha256`은 원본 manifest 바이트의 해시입니다. 참조는 `{kind, id, sha256}` 형태이며 SHA-256은 소문자 64자리 16진수입니다. 작업은 `stepKey`, `operationKey`, `scope`, `cacheFingerprint`, 선택적 `cursor`로 구성합니다.
- `advanceInput(runId, {store, workflow, expectedCheckpointSeq, input, affectedScope, reuseArtifactIds, next})`는 지정한 최신 체크포인트의 자식으로 새 세대를 엽니다. 영향 범위, 재사용 ID와 참조, 새 입력, 실행할 다음 작업을 같은 체크포인트에 기록합니다. 이전 세대의 산출물은 `reuseArtifactIds`로 선택하고, 새 스냅샷의 원본 바이트는 `input`에 지정합니다. 전환 결과를 받은 뒤 새 입력으로 `resumeDurable`을 호출합니다.
- `getCheckpoint(runId, {store, checkpointSeq?})`는 현재 또는 지정한 체크포인트를, `getDurableRun(runId, {store})`는 현재 체크포인트와 실행 상태를, `getDurableAttempts(runId, {store})`는 시도와 선행 시도 및 커밋 순번을 돌려줍니다. 저장소 API인 `listCheckpoints(runId)`로 전체 체크포인트를 조회할 수 있습니다.
- 상태는 `running`, `interrupted`, `cancelled`, `failed`, `completed` 중 하나입니다. 도메인 판정은 `committed.outcome`에 있습니다. 이슈, coverage, cursor 등은 JSON으로 보존됩니다. `detailsRef`와 `coverageRef`는 해당 작업이 공개하는 목록이나 현재 세대에 공개된 ID여야 합니다.
- 잘못된 입력이나 리비전, 해시 불일치, 동시 실행 충돌은 공개 API에서 `DurableExecutionError`로 전달됩니다. 오류에는 `code`, `message`, `runId`, `checkpointSeq`, `artifactId`가 있습니다. 작업 실행 중 취소 또는 실패는 같은 오류 구조를 `DurableRunResult.error`에 담으며 마지막 체크포인트의 `next`가 재시도 대상입니다. 작업 중 발견한 아티팩트 불일치도 실패 결과에 해당 코드를 담습니다.

## 재사용과 재시도

작업 콜백의 `getArtifactRef(id)`로 현재 세대에 공개된 참조를 찾고, `readArtifact(ref)`로 바이트와 SHA-256을 확인합니다. 새 바이트는 `putArtifact(kind, bytes)`로 저장하고 반환값을 작업 결과의 `artifacts`에 넣어 공개합니다. 공개 전 프로세스가 종료되면 재개는 직전 체크포인트에서 같은 작업 키로 다시 시도합니다.

`findReusableWork()`는 현재 세대 내에서 작업 키, 단계, 범위, 커서, 지문이 일치하는 최근 커밋을 찾습니다. 호출자가 `{reuseFrom: hit.checkpointSeq, next}`를 반환하면 이전 산출물과 결과를 연결하고 재사용 출처를 기록합니다. `next`는 현재 호출의 계획에 따라 지정합니다. 지문에는 실제로 읽은 아티팩트 해시, 범위와 규칙·엔진 버전을 포함하세요. 작업 시도마다 고유 ID가 생성됩니다. 외부 시스템 호출과 파일 쓰기의 멱등성은 논리 작업 키나 실행 ID·세대·작업 키의 조합으로 호출자가 처리합니다.

SQLite 저장소는 프로세스 간 임대와 순번 비교를 사용합니다. 프로세스가 강제 종료되면 임대 만료 후 재개할 수 있습니다. 기본 임대는 30초입니다. 콜백은 `signal`을 공급자에 전달하고, CPU 작업은 이벤트 루프가 임대를 갱신할 수 있어야 합니다. 체크포인트 공개가 이미 끝났다면 조회 결과에 해당 작업의 커밋이 남습니다. 데이터베이스와 저널은 SQLite 잠금을 지원하는 로컬 파일시스템에 보관하세요. 미공개 바이트는 조회 가능한 작업 산출물 목록에서 제외되며 저장소의 물리적 정리는 수동으로 관리합니다.

SQLite 옵션은 Node.js 22.13 이상에서 바로 사용할 수 있습니다. Node.js 22.12에서는 `--experimental-sqlite` 플래그로 저장소를 활성화합니다. [Node.js 22.12 SQLite 문서](https://nodejs.org/download/release/v22.12.0/docs/api/sqlite.html)

정적 재분석 범위, 입력 수집 여부, 동일 오류 반복 중단, 발행 조건은 워크플로 콜백이 결정합니다. `Cycle.run`으로 등록한 기존 워크플로는 별도 영속 작업 정의를 작성해 이 API에 연결할 수 있습니다.
