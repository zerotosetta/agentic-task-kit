# 장시간 MCP 실행 상태·재연결 검증

2026-11-19 · Windows 로컬 · ATK `0.1.9-poc2.4` · Astra 구현 및 독립 검토

## 변경과 기존 계약

기존 시작 도구는 완료 대기 없이 runId를 반환하고, 같은 상태 저장소의 같은 프로필·idempotencyKey·요청을 다시 받으면 기존 실행을 반환한다. 이 동작과 detached worker를 재사용했다.

추가한 계약은 다음과 같다.

- 플러그인: `reportProgress({attemptId: ctx.attemptId, stepKey: ctx.work.stepKey, operation, completed, total, unit, item, message})`.
- 상태: `lastCompletedStep`, `progress`, `lastProgressAt`, `worker`, `nextAction`.
- 생존 정보: worker PID·시작·heartbeat·임대 만료. 실제 관측 종료와 임대 만료를 각각 `WORKER_EXITED`, `WORKER_LEASE_EXPIRED`로 표시한다.
- 오류: 기존 `STEP_FAILED` 등 외부 코드와 원래 오류의 `cause.code/message/recoverable`을 보존한다. 명시적 복구 불가 상태에는 inspect를 안내하고 resume를 거부한다. 과거 형식의 복구 여부 미지정 실패는 운영자가 명시적으로 재개할 수 있다.

보고는 작업 시도 ID·실행 토큰·유효 임대로 제한한다. 단계가 같은 다음 시도에서 공유 EventEmitter가 이전 콜백을 다시 호출해도 과거 attemptId는 반영되지 않는다. 같은 보고의 반복과 heartbeat는 실제 진척 시각을 갱신하지 않는다. sequence와 마지막 진척 시각은 같은 runId의 재개에서도 유지한다.

기존 응답 필드, durable checkpoint schemaVersion 1, 입력 세대·재실행 의미 및 `runs/<runId>` 경로를 유지한다. 진척 보고는 체크포인트를 추가하지 않는다.

## 합성 실행 관측

현장 원문·덤프·실제 Oracle/Qwen은 사용하지 않았다. 통합 시험은 소스에서 빌드한 stdio MCP 서버와 실제 detached Node worker를 사용하며, 대기·해제 파일로 단계를 제어한다. 아래 ID는 이 합성 시험의 실제 관측값이다.

| 상황 | 관측 | 중복·재개 판정 |
| --- | --- | --- |
| 첫 start 응답 유실 후 재요청 | `14cbcc07-9a66-48cd-8783-e624920c9a28`, factory 1회, runs 디렉터리 1개, worker PID 28880 | 같은 키 재회수 시 같은 runId, 중복 실행 0개 |
| 느리게 진행하는 한 단계 | 같은 CP1에서 page-1.jsp 1/3 seq1 → page-2.jsp 2/3 seq2 → 완료 시 3/3 seq3 | 건수 증가에 체크포인트 불필요, 무진척 대기 중 heartbeat만 갱신 |
| 호스트 대기 만료·클라이언트 종료 | 100ms의 실제 polling deadline 만료 후 stdio를 닫고 다시 접속 | worker 취소 없이 같은 runId로 완료. 현장 300초를 그대로 기다리는 시험은 아님 |
| 실제 worker 강제 종료 | `f8df6fb8-1740-40c6-be0f-7e95070abba7`, 기존 PID 32240, CP1 뒤 finish 도중 종료 | WORKER_EXITED 원인 유지, 같은 runId·마지막 완료 헤드에서 재개 |
| 서버도 끊긴 상태의 worker 종료 | 서버 재연결 뒤 worker 임대 만료를 조회 | WORKER_LEASE_EXPIRED로 구분하고 같은 runId에서 재개 |
| 입력 전환을 포함한 7단계 | `b9f115d9-09dc-4fc5-9ee1-adde62c5ab3f`: 작업 커밋 CP1,2,3,5,6,7,8; CP4는 generation 1 입력 전환 | 실제 작업 시도 7개. CP4에서도 마지막 완료 단계는 parse/CP3이고 현재는 map |
| 복구 불가 플러그인 오류 | `ca936539-208b-455b-b4c7-c257b030aa2f`: STEP_FAILED → cause SOURCE_UNREADABLE, recoverable false | status와 재개 거부 응답에 원인 유지, nextAction inspect |

완료 단계명은 collect → inventory → parse → map → validate → summarize → finish의 합성 workflow다. 현장 analysis4 7단계를 실제 재실행했다는 의미는 아니다. 기존 generation·rerun·취소·결과 페이지·프로토콜 호환 시험도 통과했다.

## 상태 응답 예시

실제 관측 응답에서 관련 필드만 발췌했다. 시각은 ISO UTC이며 첫 진척의 한국 시각은 2026-11-19 21:32:40이다.

```json
{
  "runId": "14cbcc07-9a66-48cd-8783-e624920c9a28",
  "status": "running",
  "checkpointSeq": 1,
  "currentStep": "finish",
  "lastCompletedStep": { "stepKey": "collect", "checkpointSeq": 1, "generation": 0 },
  "progress": {
    "attemptId": "6ff144f4-9003-4cc0-83c5-a284d847bf25",
    "stepKey": "finish", "operation": "index",
    "completed": 2, "total": 3, "unit": "files", "item": "page-2.jsp",
    "sequence": 2, "updatedAt": "2026-11-19T12:32:40.772Z",
    "generation": 0, "checkpointSeq": 1
  },
  "lastProgressAt": "2026-11-19T12:32:40.772Z",
  "worker": { "state": "alive", "pid": 28880 },
  "nextAction": {
    "action": "status", "tool": "workflow_status",
    "arguments": { "runId": "14cbcc07-9a66-48cd-8783-e624920c9a28" },
    "retryAfterMs": 1000
  }
}
```

위 예시는 일부 필드를 생략했다. 실제 전체 응답에는 lastCompletedStep.outcome, worker의 각 시각, nextAction.reason 및 기존 필드도 포함된다.

## 로컬 검사 결과

- `npm run typecheck`: 통과.
- `npm test`: 21개 파일, 210개 테스트 통과.
- `npm test -- tests/mcp-server.test.ts`: 통합 13개 통과. 마지막으로 보강한 호스트 대기 만료 시험도 개별 통과.
- `npm run test:architecture`: 97개 모듈 통과.
- `npm run build`: 타입 선언·bundle 통과.
- `npm run test:package`: 일반 dist의 97개 모듈 통과.
- all-in-one 생성 후 `npm run test:package -- .npm-package/dist`: 97개 모듈 통과.
- sample-project 타입 검사와 기존 consumer 실행: 통과.
- `git diff --check`: 통과.

로컬 패키지는 `out/mcp-long-running/agentic-task-kit-0.1.9-poc2.4.tgz`이다. npm 공개나 현장 배치는 수행하지 않았다. 패키지의 201개 파일 항목에 진단 자료·덤프·HAR·SQLite 상태·현장 원문은 포함되지 않는다.

analysis4는 처리 파일마다 위 reportProgress를 호출하고, CLI에 progress.sequence/updatedAt와 worker.heartbeatAt을 따로 표시해야 한다. ATK 변경만으로 기존 플러그인이 파일별 진척을 보내지는 않는다. attempts/runs 경로 축소와 LFJ 재연결·classpath 복원은 어댑터 측 담당으로 유지한다.
