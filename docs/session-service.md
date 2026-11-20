# ATK 작업 세션 서비스

에이전트는 `/mcp`로 접속하고 사람은 `/app`을 연다. 세션의 목표, 마지막 인계, 파일 버전, 워크플로 체크포인트와 발행 결과가 서버의 `stateDirectory`에 남는다. 에이전트가 바뀌면 업무명으로 검색해서 이어갈 수 있다.

## 실행

Node.js 22.13 이상과 ATK 패키지를 설치한 프로젝트에서 실행한다. 기존 파이프라인의 MCP 설정 파일을 그대로 사용한다. 새 프로젝트에서는 `atk-mcp init`으로 프로젝트를 만들고 패키지 설치 후 `npm run setup`을 실행하면 예제 `atk-mcp.json`이 생성된다. [파이프라인 시작 가이드](./pipeline-sdk.md)

```powershell
$env:ATK_SERVICE_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
Set-Clipboard -Value $env:ATK_SERVICE_TOKEN
npx --no-install atk-mcp serve --config ./atk-mcp.json --host 127.0.0.1 --port 4317
```

브라우저에서 `http://127.0.0.1:4317/app`을 열고 토큰을 붙여 넣는다. 로그인 정보는 현재 웹 페이지의 메모리에 둔다. OS 서비스 관리자로 실행할 때는 토큰을 비밀 설정으로 공급하고, 같은 설정 파일과 영속 저장 경로를 유지한다. 서버 프로세스가 종료돼도 작업 파일과 이미 커밋된 단계는 보존된다.

원격 MCP 클라이언트에는 다음 값을 지정한다.

| 설정 | 로컬 실행 값 |
| --- | --- |
| 전송 | Streamable HTTP |
| URL | `http://127.0.0.1:4317/mcp` |
| 요청 헤더 | `Authorization: Bearer <ATK_SERVICE_TOKEN의 값>` |
| 프로토콜 리비전 | `2025-11-25` 또는 `2025-06-18` |

다른 PC에서 연결할 때는 HTTPS 역방향 프록시 뒤에 서비스를 두고 `ATK_SERVICE_ORIGIN`에 외부 origin(예: `https://atk.example.org`)을 지정한다. 프록시는 해당 Host 헤더를 보존한다. 기본 리스너는 루프백이다. 이 버전은 서비스 인스턴스당 한 팀의 공유 작업공간을 제공한다. 토큰 보유자는 그 인스턴스의 세션을 조회·수정하고 실행을 제어할 수 있다. 업무별 접근 경계를 나누려면 토큰과 저장 경로가 다른 인스턴스를 사용한다.

## 첫 에이전트와 다음 에이전트

아래는 MCP `tools/call`로 전달하는 도구명과 인수의 예다. `S`와 `R`은 앞 호출에서 받은 실제 ID로 대체한다.

| 순서 | 도구 | 인수 예시 |
| --- | --- | --- |
| 1 | `session_create` | `{"title":"단어 수 보고서","goal":"입력 문장의 단어 수 발행","idempotencyKey":"report-001"}` |
| 2 | `workspace_write` | `{"sessionId":"S","path":"input/note.txt","content":"one two three","expectedVersion":0}` |
| 3 | `session_note` | `{"sessionId":"S","expectedVersion":1,"summary":"입력 검수 완료","nextAction":"분석 결과 확인"}` |
| 4 | `workflow_start` | `{"sessionId":"S","profile":"word-report","request":{"text":"one two three"},"idempotencyKey":"start-001"}` |
| 5 | `session_list` | 다음 에이전트가 `{"query":"단어 수 보고서"}`로 검색한다. 이름이 같으면 목표와 ID를 확인한다. |
| 6 | `session_context` | `{"sessionId":"S"}`로 인계 기록, 파일 목록, 현재 단계, 실제로 커밋한 단계, 다음 행동과 최종 파일을 받는다. |
| 7 | `workflow_resume` | 중단 상태에서 `run.nextAction.arguments`를 전달한다. 체크포인트가 있으면 `sessionId`, `runId`, `expectedCheckpointSeq`, `expectedInputSha256`을 포함한다. |
| 8 | `workflow_results` | `{"sessionId":"S","runId":"R","artifactId":"…"}`로 커밋된 파일을 읽는다. 큰 파일은 `nextCursor`로 나누어 내려받는다. |

한 세션은 워크플로 하나와 연결된다. 실행을 시작하기 전에도 메모와 파일을 저장할 수 있다. 같은 세션에서 같은 프로필·요청·키로 시작을 재전송하면 같은 실행을 돌려준다. 입력을 바꾸어 별도 실행하려면 세션을 새로 만든다. 기존 체크포인트에서 선택한 단계를 다시 수행하려면 프로필의 `workflow_rerun`을 사용한다. 연결 종료만으로 워커는 취소되지 않는다. 사람이 자료를 제출해야 하는 도메인 단계에서는 프로필이 정한 제출 경로를 따른다.

`workspace_list`, `workspace_read`, `workspace_write`는 UTF-8 텍스트 파일당 최대 1 MiB를 지원한다. `workspace_read`의 `version`을 생략하면 최신본을 읽고, 지정하면 그 버전을 읽는다. 수정할 때는 읽어 둔 `expectedVersion`을 보낸다. 인계 메모도 같은 방식으로 충돌을 알린다. 워커에 전달할 값은 프로필의 입력 스키마에 맞춰 `request`에 담는다. 워커가 생산한 바이너리와 보고서는 기존 체크포인트 산출물 저장소에서 읽는다.

## 모니터링과 복구

홈에는 세션별 현재 상태와 진행 단계가 표시된다. 상세 주소 `/app/sessions/<sessionId>`에서는 공개 단계 순서, 현재 작업 처리량, 마지막 커밋과 인계, 작업 파일, 중간·최종 산출물을 확인한다. ‘확정 기록 있음’(`completedStages`)은 이전 재실행과 입력 버전의 커밋도 포함한다. 현재 실행 상태는 `run`과 `progress`에서 확인한다. 화면은 주기적으로 갱신되며 편집 중인 초안은 보존한다. 전체 작업량이 없는 실행은 단계 위치와 실제 보고된 수치로 표시한다.

재접속 후 실행 중이면 관찰을 계속하고, 중단 상태라면 현재 체크포인트에서 재개한다. 앞선 에이전트가 저장하지 않은 편집 내용은 복구되지 않는다. 서버나 워커의 비정상 종료로 임대가 남아 있으면 상태 조회 후 재개 가능 여부를 확인한다. 상태가 바뀌어 충돌이 나면 최신 `session_context`를 읽는다. 예전 stdio 작업은 원래 인터페이스에서 조회하며, 이 서비스는 자신이 세션에 연결해서 시작한 실행을 제공한다.

백업은 서비스와 실행 워커가 모두 정지한 시점에 전체 `stateDirectory`, 원본 설정, 고정된 프로필 모듈·입력을 함께 복사한다. `sessions.sqlite`에 인계와 작업 파일, `jobs.sqlite`에 세션과 실행의 연결, `execution.sqlite`와 `runs/`에 체크포인트와 실행별 복구 데이터가 있다.
