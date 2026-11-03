# 명령 실행 AIProvider

`apiType: "command"` 또는 `createCommandAIProvider()`로 `bxca -p "[MESSAGE]"` 같은 CLI를 `ctx.ai.chat()`에 연결한다. HTTP API key/baseURL 설정은 필요하지 않다. CLI 자체 인증 설정은 해당 프로그램의 환경을 사용한다.

실행 가능한 [bxca 활용 샘플](./bxca-sample.md)은 요구사항 분석 → 실행 계획 → 검토 보고서를 생성하면서 Memory/Artifact/renderer를 함께 사용한다. `npm run example:bxca:demo`로 외부 모델 호출 없이 확인할 수 있다.

## bxca 형태로 사용

```ts
import { createAIProvider, createCycle } from "agentic-task-kit";

const ai = createAIProvider({
  apiType: "command",
  providerName: "cli",
  timeoutMs: 180_000,
  command: {
    executable: "bxca",
    args: ["-p", "{message}"],
  },
});
const cycle = createCycle({ aiProvider: ai });
const response = await ai.chat({
  messages: [{ role: "user", content: "이 코드를 설명해줘" }],
});
console.log(response.outputText);
```

`executable`은 실행 파일 이름/경로, `args`는 **각각의 인자**다. `"bxca -p ..."` 전체 문자열을 executable에 넣지 않는다. `{message}` 바깥에 셸용 따옴표를 추가하지 않는다. 한글, 줄바꿈, 따옴표, `&`, `%PATH%`, `$()`도 문자열 데이터로 전달한다. 실제 bxca/모델은 호출하지 않았으며 이 계약을 로컬 fixture 명령으로 검증했다.

직접 factory도 동일하다.

```ts
import { createCommandAIProvider } from "agentic-task-kit";
const ai = createCommandAIProvider({
  command: { executable: "bxca" }, // 기본 args: ["-p", "{message}"]
});
```

## 입력 구성

- 단일 user 텍스트는 원문 그대로 전달한다. 여러 메시지는 `[system]\n...\n\n[user]\n...` 형태로 role/name과 순서를 보존한다. text/input_text 파트도 지원한다.
- `request.command.message`로 최종 문자열을 직접 지정할 수 있다. 빈 문자열도 허용한다.
- `command.buildMessage(request)`는 CLI가 요구하는 프롬프트/JSON을 구성한다. 명시한 request.command.message가 우선한다.
- payload/defaultPayload를 지정하면 native 필드를 유지한 JSON 문자열을 전달한다. 공통 messages/model과 shallow merge하고, `payloadMode: "replace"`는 defaults와 공통 매핑을 생략한다. CLI 고유 schema를 강제하지 않는다.
- 기본 텍스트 변환은 이미지 파트를 조용히 생략하지 않고 오류로 알린다. 멀티모달 CLI는 native payload 또는 buildMessage를 사용한다.
- args의 `{message}`와 `{model}`은 한 번 치환한다. 메시지 내부의 템플릿/셸 문자를 다시 해석하지 않는다. `{model}`을 사용한다면 defaultModel/request.model/native payload.model을 지정한다. temperature 등 CLI별 옵션은 args나 buildMessage에서 구성한다.

```ts
const response = await ai.chat({ command: { message: "최종 프롬프트 원문" } });
```

긴 프롬프트는 운영체제의 인자 길이 제한을 받을 수 있다. CLI가 stdin을 읽는 경우 아래처럼 설정하고 필요한 CLI 옵션을 args에 넣는다. bxca의 stdin 옵션을 임의로 가정하지 않는다.

```ts
const ai = createCommandAIProvider({
  command: {
    executable: "your-cli",
    input: "stdin",
    args: [],
  },
});
```

`cwd`로 실행 폴더를 지정하고 `env`로 부모 환경변수를 덮어쓴다. `null`은 변수를 제거한다. Windows에서 Path/PATH 같은 이름은 대소문자를 구분하지 않고 정리한다. 호출마다 별도 프로세스를 만들며 자동 재시도나 동시성 제한을 적용하지 않는다.

## 출력 구성

기본 답변은 stdout 전체이며 공백/개행을 trim하지 않는다. stderr는 답변에 합치지 않고 raw에 보존한다. CLI가 JSON을 출력한다면 parser를 지정한다.

```ts
const ai = createCommandAIProvider({
  command: {
    executable: "your-cli",
    args: ["--json", "-p", "{message}"],
    parseOutput(result) {
      // 필드명은 예시다. 사용하는 CLI의 실제 출력 schema에 맞춘다.
      const value = JSON.parse(result.stdout);
      return { text: value.answer, model: value.model, usage: value.usage };
    },
  },
});
```

`raw`에는 stdout, stderr, exitCode, signal, elapsedMs, buffered가 포함된다. 종료 코드가 0이어야 성공이다. `chatStream()`은 프로세스 완료 후 **1개 chunk**를 반환하는 buffered 구현이다. iterator의 조기 return은 진행 중인 명령을 취소한다.

## 취소와 오류

전체 제한 시간은 기본 60초다. provider의 timeoutMs 또는 공통 요청 옵션인 `request.http.timeoutMs`로 지정하며 `0`은 제한을 끈다. `request.http.signal`은 기존 workflow cancellation과 호환된다. 이 옵션명이 http여도 command provider에서 네트워크 호출을 수행하지 않는다.

취소/timeout/출력 초과 시 Unix process group 또는 Windows taskkill로 자식 프로세스까지 종료한다. stdout/stderr 합계는 기본 10 MiB이며 command.maxOutputBytes로 변경한다. 명령을 다시 실행하면 중복 작업이 될 수 있어 maxRetries와 관계없이 자동 재시도하지 않는다.

오류는 AIProviderRequestError로 전달한다.

| code | 의미 |
| --- | --- |
| ENOENT 등 OS code | 실행 파일을 찾거나 시작하지 못함 |
| command_exit_error | 비정상 종료; responseBody에 exitCode/stdout/stderr/signal 보존 |
| command_timeout / command_aborted | 시간 초과 / 취소 |
| command_output_limit | 합산 출력 제한 초과 |
| command_stdin_error | stdin 전달 실패 |
| command_unsupported_script | Windows에서 지원하지 않는 batch wrapper |
| command_termination_error | 프로세스 종료 처리 실패 |

명령 provider는 프롬프트·args·env를 별도 process debug 로그로 출력하지 않는다. 기존 workflow 모니터링의 prompt/output 미리보기는 유지한다. raw/error에는 CLI 출력이 포함될 수 있다.

## Windows

native executable과 경로의 공백을 지원한다. PATH에서 찾은 **인식 가능한 표준 npm Node `.cmd` shim**은 해당 JS 진입점을 현재 Node로 직접 실행한다. 따라서 사용자 메시지를 cmd 문자열에 삽입하지 않는다.

일반 `.cmd`/`.bat`는 자동 shell 실행하지 않는다. 해당 CLI의 native 실행 파일 또는 Node 진입점을 명시한다.

```ts
const ai = createCommandAIProvider({
  command: {
    executable: process.execPath,
    args: ["C:/tools/bxca/cli.js", "-p", "{message}"],
  },
});
```

## JSON config

```json
{
  "apiType": "command",
  "providerName": "cli",
  "timeoutMs": 180000,
  "command": {
    "executable": "bxca",
    "args": ["-p", "{message}"]
  }
}
```

`createAIProviderFromConfigFile({ configPath })`로 읽는다. command 설정은 overrides.command와 shallow merge한다. buildMessage/parseOutput 함수는 코드 또는 overrides로 지정한다. env 맵은 override 시 전체 교체된다.
