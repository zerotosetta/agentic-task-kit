# bxca로 실행하는 ATK 활용 샘플

등록한 `bxca -p "메시지"`를 ATK의 AIProvider로 사용해 요구사항 파일을 분석하고 실행 계획과 검토 보고서를 만든다. 기본 입력은 가상의 **모바일 이체 한도 변경 요구사항**이다. 실제 코드를 수정하지 않고 검토 문서를 생성하는 예제다.

## 빠른 실행 (Windows / PowerShell)

라이브러리 저장소 `agentic-task-kit`에서 최초 한 번 의존성을 설치한다.

```powershell
npm.cmd ci
npm.cmd --prefix .\sample-project ci
```

로컬 데모는 API 키나 bxca 설치 없이 동일한 command provider 경로를 실행한다.

```powershell
npm.cmd run example:bxca:demo
```

등록한 bxca를 사용하는 실제 실행:

```powershell
npm.cmd run example:bxca
```

실제 실행은 **모델 요청 3회**를 수행한다. 인증과 기본 모델은 bxca 자체 설정을 그대로 사용한다. ATK용 API key/baseURL은 설정하지 않는다. 모든 start 스크립트는 라이브러리를 먼저 build한다.

## 샘플 디렉터리에서 실행

```powershell
cd .\sample-project
npm.cmd run start:bxca:demo
npm.cmd run start:bxca:line
npm.cmd run start:bxca:ink
```

직접 만든 UTF-8 Markdown/텍스트 파일을 전달할 수 있다. 상대 경로는 `sample-project` 기준이다. 절대 경로를 사용하면 실행 위치에 영향을 받지 않는다.

```powershell
npm.cmd run start:bxca -- "C:\work\requirements.md"
npm.cmd run start:bxca:demo -- "C:\work\requirements.md"
npm.cmd run start:bxca:ink -- --demo
```

POSIX shell에서는 `npm.cmd` 대신 `npm`을 사용한다.

## ATK가 담당하는 흐름

| Task | 역할 | 모델 호출 | 파일 |
| --- | --- | --- | --- |
| load | 입력 파일 검증, workflow memory에 저장 | 없음 | 00-requirements.md |
| analysis | 목표·제약·미확정 사항 분석 | bxca -p | 01-analysis.md |
| plan | 요구사항과 분석을 읽어 실행/테스트 계획 작성 | bxca -p | 02-plan.md |
| review | 요구사항·분석·계획을 대조해 누락과 다음 행동 정리 | bxca -p | 03-review.md |

- `createWorkflowInput()`의 Map으로 입력/출력 경로를 전달한다.
- Task는 `ctx.ai.chat()`을 호출한다. command provider가 각 요청을 `bxca -p <프롬프트>` 프로세스로 실행하고 stdout을 답변으로 받는다.
- 단계 간 문서는 실행별 `workflow/raw` 메모리 레코드에 누적하고 `ctx.memory.get()`으로 읽는다. runtime은 별도로 task 이력과 workflow summary를 생성한다.
- 각 문서는 `ctx.artifacts.create()`로 등록하면서 디스크에도 즉시 저장한다.
- line renderer가 기본이며 `start:bxca:ink`는 기존 Ink TUI를 사용한다. Ink에서 `q`/`Ctrl+C`는 ATK 취소를 통해 실행 중인 command에 전달된다.

핵심 설정은 [cycle.bxca.config.json](../sample-project/cycle.bxca.config.json)이다.

```ts
const ai = createCommandAIProvider({
  providerName: "bxca",
  timeoutMs: 180_000,
  command: {
    executable: "bxca",
    args: ["-p", "{message}"],
  },
});
const cycle = createCycle({ aiProvider: ai });
// Workflow Task 내부:
const response = await ctx.ai.chat({
  messages: [{ role: "user", content: "요구사항을 분석해 주세요." }],
});
```

`-p` 다음에는 셸 따옴표를 덧붙이지 않은 **독립 인자**로 프롬프트가 전달된다. Windows의 표준 npm `.cmd` shim도 지원한다. 세부 계약은 [command API](./command-api.md)를 참고한다.

## 실행 설정

| 환경변수 | 기본값 | 의미 |
| --- | --- | --- |
| BXCA_EXECUTABLE | bxca | PATH 이름 또는 실행 파일/표준 npm shim의 절대 경로 |
| BXCA_MODEL | 미지정 | 지정하면 bxca에 `-m <모델>` 추가. 생략하면 bxca 기본 모델 사용 |
| BXCA_TIMEOUT_MS | 180000 | 모델 요청별 제한 시간. 0은 제한 없음 |
| CYCLE_RENDER_MODE | line | line/ink 등 기존 ATK renderer 모드 |

```powershell
$env:BXCA_EXECUTABLE = "$env:APPDATA\npm\bxca.cmd"
$env:BXCA_TIMEOUT_MS = "240000"
npm.cmd run start:bxca
```

`BXCA_EXECUTABLE`에는 `bxca -p ...` 전체 명령문을 넣지 않는다. CLI 인증 설정은 자식 프로세스가 부모 환경에서 상속한다.

## 결과와 실패 처리

`sample-project/generated/bxca-<입력명>-<시각>-<고유값>/` 아래에 위 문서와 `90-memory-snapshot.json`, `91-run-frame.json`을 저장하고 터미널에 경로를 출력한다. 원본과 생성 문서를 포함하므로 이 폴더는 git에서 제외한다.

명령 비정상 종료, 빈 응답, timeout, 잘못된 입력은 workflow 실패로 처리한다. 후속 Task는 실행하지 않고 완료된 문서와 실패 frame을 남기며 프로세스는 exit code 1로 종료한다. 자동 재시도는 하지 않는다.

이 샘플은 Windows 인자 길이 제한을 고려해 입력과 각 답변을 **6000자 이하**로 제한한다. 기본 프롬프트는 답변 3000자 이내를 요청한다. 긴 문서는 분할하거나 별도의 파일/stdin 전달 방식을 설계한다.

## 검증

```powershell
npm.cmd run test:bxca
```

로컬 Node fixture로 자식 프로세스 3회, 한글/따옴표/메타문자 보존, 메모리 전달, artifact 파일 일치, 오류/빈 stdout/timeout, CLI 실패 종료를 검증한다. demo 결과는 고정된 예시이며 실제 모델의 분석 결과가 아니다. 실제 모델 호출은 이 샘플의 자동 테스트에서 수행하지 않는다.
