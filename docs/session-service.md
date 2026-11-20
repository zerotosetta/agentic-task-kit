# ATK 작업 세션 서비스

에이전트는 `/mcp`로 접속하고 사람은 `/app`을 연다. 세션의 목표, 마지막 인계, 파일 버전, 워크플로 체크포인트와 발행 결과가 서버의 `stateDirectory`에 남는다. 에이전트가 바뀌면 업무명으로 검색해서 이어갈 수 있다.

## 독립 실행

Windows x64에서는 `atk-session-service-0.2.0-sdk.5-win-x64.zip`을 쓰기 가능한 폴더에 풀고 **start-atk.cmd**를 실행한다. ZIP 안의 Node.js로 MCP와 웹을 함께 제공한다. 기본 웹 주소는 `http://127.0.0.1:4317/app`, MCP 주소는 `http://127.0.0.1:4317/mcp`다. 처음 실행할 때 생성되는 `data/access-token.txt`의 값을 MCP 클라이언트의 Bearer 토큰으로 사용한다. 같은 `data` 폴더로 다시 실행하면 파일 버전, 발행된 산출물과 이력이 복원된다.

Node.js 22.13 이상을 사용하는 환경에서는 SDK 압축 패키지를 새 폴더에 설치할 수 있다. 아래 명령은 워크플로 프로필 없이 세션 저장소를 연다. 서버에 공급한 토큰은 재시작할 때도 같은 값을 사용한다.

```powershell
$packageFile = (Resolve-Path .\agentic-task-kit-0.2.0-sdk.5.tgz).Path
npm install --offline --ignore-scripts --no-audit --no-fund $packageFile
$env:ATK_SERVICE_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
npx --no-install atk-mcp serve --state ./data
```

이 저장소에서 배포 파일을 다시 만들 때 Windows x64 ZIP은 `npm run pack:windows`, SDK tgz는 `npm run pack:all-in-one`을 사용한다. ZIP은 `out/pipeline-sdk`에 생성된다. 패키징 환경에 Node.js의 라이선스 파일이 없으면 해당 런타임 버전의 공식 LICENSE를 받아 포함한다. 오프라인 패키징에서는 `ATK_NODE_LICENSE_FILE`에 해당 파일 경로를 지정한다.

## 워크플로와 함께 실행

Node.js 22.13 이상과 ATK 패키지를 설치한 프로젝트에서 실행한다. 기존 파이프라인의 MCP 설정 파일을 그대로 사용한다. 새 프로젝트에서는 `atk-mcp init`으로 프로젝트를 만들고 패키지 설치 후 `npm run setup`을 실행하면 예제 `atk-mcp.json`이 생성된다. [파이프라인 시작 가이드](./pipeline-sdk.md)

```powershell
$env:ATK_SERVICE_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
npx --no-install atk-mcp serve --config ./atk-mcp.json --host 127.0.0.1 --port 4317
```

서비스를 실행한 PC에서 `http://127.0.0.1:4317/app`을 열면 이 인스턴스에 생성된 세션이 모두 표시된다. 상세 주소도 바로 열 수 있다. 로컬 웹은 브라우저에 토큰을 입력할 필요가 없다. MCP 클라이언트는 아래 토큰으로 인증한다. OS 서비스 관리자로 실행할 때는 토큰을 비밀 설정으로 공급하고 같은 설정 파일과 영속 저장 경로를 유지한다.

원격 MCP 클라이언트에는 다음 값을 지정한다.

| 설정 | 로컬 실행 값 |
| --- | --- |
| 전송 | Streamable HTTP |
| URL | `http://127.0.0.1:4317/mcp` |
| 요청 헤더 | `Authorization: Bearer <ATK_SERVICE_TOKEN의 값>` |
| 프로토콜 리비전 | `2025-11-25` 또는 `2025-06-18` |

서비스는 한 팀의 작업공간을 제공한다. 기본 루프백 주소에서는 이 PC의 사용자가 모든 세션을 열고 변경하거나 삭제할 수 있다. 다른 PC에 웹을 제공할 때는 HTTPS 역방향 프록시에 사용자 인증을 구성하고 `ATK_SERVICE_ORIGIN`에 외부 origin(예: `https://atk.example.org`)을 지정한다. 프록시는 원래 Host를 보존하고 인증을 통과한 웹 사용자의 `/api/tools/*` 요청에 서버 측에서 Bearer 토큰을 설정한다. 에이전트의 `/mcp` 연결에는 해당 클라이언트의 인증 헤더를 전달한다.

## 첫 에이전트와 다음 에이전트

### 에이전트가 직접 작성한 산출물

아래 예시는 MCP `tools/call`의 도구명과 인수다. `S`는 생성하거나 찾은 세션 ID, `P`는 발행 응답의 `publicationId`로 바꾼다.

| 작업 | 도구 | 인수 예시 |
| --- | --- | --- |
| 세션 생성 | `session_create` | `{"title":"분석 보고서","goal":"검토한 분석 결과 인계","idempotencyKey":"report-07"}` |
| 파일 1판 저장 | `workspace_write` | `{"sessionId":"S","path":"보고서.md","expectedVersion":0,"content":"# 검토 결과\n확인한 항목 3개","actor":"분석 에이전트","stage":"분석","reason":"검토 결과를 초안으로 저장"}` |
| 중간본 발행 | `artifact_publish` | `{"sessionId":"S","path":"보고서.md","version":1,"role":"intermediate","actor":"분석 에이전트","stage":"분석","reason":"검토자에게 초안 전달","idempotencyKey":"draft-1"}` |
| 최종본 발행 | `artifact_publish` | 파일을 `expectedVersion: 1`로 수정해 2판을 받은 뒤 `{"sessionId":"S","path":"보고서.md","version":2,"role":"final","actor":"검토 에이전트","stage":"검토","reason":"검토 의견 반영 완료","idempotencyKey":"final-2"}` |
| 발행본 목록과 본문 | `artifact_list`, `artifact_read` | `{"sessionId":"S"}`로 목록을 조회하고 `{"sessionId":"S","publicationId":"P"}`로 고정된 본문과 SHA-256을 읽는다. |
| 변경 이력 | `session_history` | `{"sessionId":"S","limit":25}`로 최근 이력을 읽는다. 다음 페이지는 응답의 `nextBeforeSeq`를 `beforeSeq`로 전달한다. |

파일의 3판을 저장해도 이미 발행한 2판의 내용은 유지된다. 같은 발행 요청을 재전송할 때는 같은 `idempotencyKey`를 사용한다. 다음 에이전트는 `session_context.workspacePublications`에서 발행 ID와 버전을 찾을 수 있다. 사람은 같은 세션의 **중간 산출물**, **최종 결과물**, **작업 이력**에서 확인한다.

작업 이력에는 파일 저장, 인계 메모 수정과 산출물 발행이 시간순으로 남는다. `actor`는 호출자가 기록한 표시 이름이며 서비스 인증은 인스턴스의 공유 토큰으로 수행한다. `workspace_write`와 `session_note`에도 `actor`, `stage`, `reason`을 전달할 수 있다. 이전 버전의 파일과 메모도 이력에 포함되며 당시 기록되지 않은 작성 정보는 비어 있다. 직접 발행할 수 있는 파일은 작업공간에서 지원하는 UTF-8 텍스트로, 파일 버전당 최대 1 MiB다.

### 워크플로가 생성한 산출물

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

중간 또는 최종 산출물의 **내용 보기**를 누르면 SHA-256 검증 후 같은 화면에 내용이 펼쳐진다. JSON은 들여쓰기로, Markdown과 일반 텍스트는 원문으로, HTML은 격리된 읽기 화면으로 표시한다. PNG·JPEG·GIF·WebP는 이미지로 표시한다. **검증 후 다운로드**로 원본을 저장할 수 있다.

재접속 후 실행 중이면 관찰을 계속하고, 중단 상태라면 현재 체크포인트에서 재개한다. 앞선 에이전트가 저장하지 않은 편집 내용은 복구되지 않는다. 서버나 워커의 비정상 종료로 임대가 남아 있으면 상태 조회 후 재개 가능 여부를 확인한다. 상태가 바뀌어 충돌이 나면 최신 `session_context`를 읽는다. 예전 stdio 작업은 원래 인터페이스에서 조회하며, 이 서비스는 자신이 세션에 연결해서 시작한 실행을 제공한다.

백업은 서비스와 실행 워커가 모두 정지한 시점에 전체 `stateDirectory`, 원본 설정, 고정된 프로필 모듈·입력을 함께 복사한다. `sessions.sqlite`에 인계와 작업 파일, `jobs.sqlite`에 세션과 실행의 연결, `execution.sqlite`와 `runs/`에 체크포인트와 실행별 복구 데이터가 있다.

## 세션 삭제

세션 상세에서 **세션 삭제**를 누르고 표시된 세션 제목을 확인한다. 확정하면 해당 세션의 인계 기록, 모든 작업 파일 버전, 연결된 실행과 체크포인트, 실행 폴더 및 전용 산출물이 삭제된다. 다른 실행도 참조하는 산출물은 유지된다.

에이전트는 `session_context`에서 읽은 최신 `session.version`을 사용해 `session_delete({"sessionId":"S","expectedVersion":2})`를 호출한다. 성공 응답은 `{"sessionId":"S","deleted":true}`다. 실행이 대기 중이거나 워커의 실행 권한이 유효하면 삭제 요청은 `RUN_ACTIVE`로 거절된다. 인계 버전이 바뀌면 최신 상태를 확인한 뒤 다시 요청한다.

응답을 받기 전에 연결이 끊기면 같은 버전으로 삭제를 재요청할 수 있다. 삭제한 세션을 만들 때 썼던 생성 키는 재사용할 수 없다. 이전 버전에서 체크포인트에 한 번도 기록되지 않았고 소유 실행도 식별할 수 없는 데이터는 저장소에 남을 수 있다.
