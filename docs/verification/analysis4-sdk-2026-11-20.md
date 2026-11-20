# analysis4 SDK 전환과 MWCOM0005 중단·재개 검수

2026-11-20, Windows 독립 배포본에서 MWCOM0005의 7단계를 실행했다. SDK 소스는 `b052a09`, 최종 ZIP의 analysis4 소스는 `58b0f55`다. ZIP의 SDK 모듈, MCP 실행 파일과 파이프라인 타입 선언의 SHA-256이 전달한 TGZ와 일치했다.

| 배포 파일 | SHA-256 |
| --- | --- |
| `agentic-task-kit-0.2.0-sdk.2.tgz` | `de46bd6e629a9955005c59749d810bc75a0ab6e7c5461e85192872c1b3088c85` |
| `analysis4-sdk-lfj041-published-20261120/analysis4-skill-win-x64.zip` | `fac6b78b829a625cdb9ee4485fe1e6683578fcee7bc4a4f8b43fc5905d80671c` |

기본 CLI와 MCP 프로필은 `definePipeline({mode: "durable"})`로 같은 7개 공개 단계와 2개 내부 제어 단계를 구성한다. SDK는 단계 범위·결과·허용 전이를 검사하고, analysis4가 커밋한 상태 참조와 발행 파일을 보존한다. 분석 규칙과 SDK 선언 지문은 실행 입력에 고정된다. [SDK의 도메인 단계 계약](../pipeline-sdk.md)

## 개발 PC 입력으로 수행한 검수

동일한 MWCOM0005 원문 9개와 오프라인 메타데이터 39행을 사용했다. `--static-only`로 실행해 5단계의 모델 작성은 건너뛰었다. 실시간 Oracle 조회도 사용하지 않았다. 세 프로젝트의 `bin`은 `class_src_wbf`, `class_src_jspeed`, `class_src_service` 순서이며 각각 클래스 0개, 958개, 0개가 들어 있었다.

| 입력 조건 | 실행 ID | LFJ 프로세스 교체 | 확인된 동작·키 | 구조 수집과 한계 |
| --- | --- | --- | --- | --- |
| 세 클래스 디렉터리 | `2a92bf41-8304-4088-99f7-a74c33c07505` | 2588 → 26648 | 22개·39개 | 구조 7개. JSP 2개에 `HttpServletRequest` 누락을 기록했다. 관측된 HTTP 필드는 0개다. |
| 같은 디렉터리 + Servlet API 3.0.1 | `2c90624f-cc5d-45e7-ad11-940add069154` | 16092 → 20208 | 81개·148개 | 구조 8개. JSP 1개에 `ScpDbAgentException` 누락을 기록했다. HTTP 필드 34개가 모두 SPEC에 연결됐다. |

각 실행에서 다음 순서를 확인했다.

1. `start --type page --id MWCOM0005 --static-only --pause-after-step root-metadata`로 시작했다. 첫 단계 커밋 후 상태는 `interrupted`, 체크포인트는 1, 다음 단계는 `discover`였다. 작업자와 첫 CLI 프로세스가 종료됐다.
2. 새 CLI에서 상태를 다시 읽고 같은 실행 ID, 체크포인트 순번과 입력 SHA-256을 지정해 `resume`을 호출했다. 4단계 `static`에서 LFJ 프로세스를 강제로 종료한 뒤, 새 LFJ가 동일한 체크포인트 해시로 원문 9개를 다시 열었다.
3. SQLite 시도 이력에서 `root-metadata → discover → dependency-metadata → static → business-authoring → verify-asis-spec → publish`가 각각 한 번씩 커밋됐다. 체크포인트 4는 입력 세대 전환이었고, 8에서 `verified-and-published`로 끝났다. 각 실행의 v2 SPEC 검증이 통과했고 발행물 11개의 바이트 해시가 최종 체크포인트와 일치했다.

운영 환경은 해당 환경의 분석 설정으로 소스 경로와 classpath를 지정한다. 개발 PC 경로, 보관 업무 JAR와 운영 전용 라이브러리는 배포 ZIP에 포함하지 않았다. 구버전으로 만든 실행의 재개는 규칙 지문 차이로 `ANALYSIS4_WORKFLOW_CHANGED`를 반환했다. 새 SDK로 시작한 실행은 위 조건에서 같은 ID로 재개됐다.

## 이전 기준 실행과의 결과 대조

같은 최종 ZIP을 새 경로에 풀고 이전 검수의 입력을 연결했다. 원문 9개와 메타데이터 39행에 실제 업무 클래스 958개를 담은 보관 JAR와 Servlet API 3.0.1을 사용했다. 새 실행 `e7fc4f6c-6e55-488a-89e6-273172032944`는 `discover`를 커밋하고 체크포인트 2에서 멈췄다. 새 CLI가 그 체크포인트와 입력 SHA-256 `f842460c72cb63d7a7d4431216ddb613f12e0cb69ac3bff145bad972f0d904b4`로 재개했다. 체크포인트 8에서 발행했고, SQLite에서 7개 단계의 커밋과 발행 파일 11개의 해시를 확인했다. 동작 106개와 키 193개의 ID 집합이 기존 검수와 일치했다.
