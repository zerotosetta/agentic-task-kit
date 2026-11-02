# 세션 기반 WebChat AIProvider

`createWebChatAIProvider()` 는 세션 생성과 메시지 등록을 묶어 `AIProvider` 로 사용할 수 있게 한다. 공통 factory 의 `apiType: "webchat"` 및 JSON config 도 지원한다.

HAR 에서 확인한 기본 경로는 아래 두 개다.

| 동작 | 요청 |
| --- | --- |
| 세션 생성 | `POST /action-webchat/post/sessions` — `title`, `assistant_uuid`, `llm_id` |
| 메시지 등록 | `POST /action-webchat/post/sessions/{sessionId}/messages` — `role`, `content` |

인증 header 기본 이름은 `BXCode-User-API-Key`, 세션 생성의 `Max-Session-Count` 기본값은 100 이다. 실제 host, 인증값, 어시스턴트/모델 식별자는 사용자가 주입한다.

**제공된 HAR 에는 실제 답변 생성·조회·토큰 스트리밍 경로가 없다.** 해당 endpoint 는 추측하지 않고 설정/콜백으로 받는다. `chat()` 에 completion 설정이 없으면 세션 생성 전에 실패한다.

## 확인된 API만 직접 사용

```ts
import { createWebChatAIProvider } from "agentic-task-kit";

const ai = createWebChatAIProvider({
  baseURL: process.env.WEBCHAT_BASE_URL!, // 서버 origin 또는 명시한 경로의 기준 URL
  apiKey: process.env.WEBCHAT_API_KEY!,
  defaultModel: process.env.WEBCHAT_MODEL!,
  webChat: { assistantUUID: process.env.WEBCHAT_ASSISTANT_UUID! },
});
const session = await ai.createSession({ webChat: { title: "새 대화" } });
const acknowledgement = await ai.appendMessage(session.sessionId, {
  role: "user", content: "질문 내용",
});
```

`acknowledgement` 는 원본 JSON 이다. 사용자 메시지 저장 응답을 AI 답변으로 변환하지 않는다. `createSession()` / `appendMessage()` 를 직접 사용하면 세션 ID 를 저장하고 후속 호출에 재사용할 수 있다. 생성한 세션을 자동 삭제하지 않는다.

## 답변 수신 방식

| `webChat.completion.mode` | 동작 |
| --- | --- |
| `append` | 메시지 등록 응답에 **새 assistant 답변까지 포함되는 서버**에 사용 |
| `request` | 등록 후 설정한 endpoint 를 한 번 호출 |
| `poll` | 설정한 endpoint 를 반복 조회; 별도 생성 요청이 필요하면 `trigger` 지정 |
| `custom` | `complete(context)` callback 으로 서비스 고유 동작 구현 |

아래 예시는 **실제 조회 경로가 확인된 후** 사용할 설정 형태다. `WEBCHAT_ANSWER_PATH` 에는 `/.../{sessionId}/...` 형태의 실제 API 경로를 넣는다. 아래 설정의 조회 메서드와 응답 필드도 서버 명세에 맞게 지정해야 한다.

```ts
import { createAIProvider, createCycle } from "agentic-task-kit";

const ai = createAIProvider({
  apiType: "webchat",
  baseURL: process.env.WEBCHAT_BASE_URL!,
  apiKey: process.env.WEBCHAT_API_KEY!,
  defaultModel: process.env.WEBCHAT_MODEL!,
  webChat: {
    assistantUUID: process.env.WEBCHAT_ASSISTANT_UUID!,
    completion: {
      mode: "poll",
      path: process.env.WEBCHAT_ANSWER_PATH!,
      method: "GET",
      intervalMs: 500,
      maxAttempts: 120,
    },
  },
});
const cycle = createCycle({ aiProvider: ai });
const response = await ai.chat({ payload: { role: "user", content: "질문" } });
```

기본 parser 는 HAR 와 같은 `message_history[].contents` JSON 문자열을 해석한다. 현재 등록한 메시지 이후의 `role: "assistant"` 응답만 반환하고, 이전 답변이나 다른 사용자 질문 뒤의 답변을 해당 호출의 결과로 재사용하지 않는다.

다른 응답 형식이면 `responsePath: ["data", "answer"]` 와 같이 명시적으로 답변 필드를 선택하거나 `extractAssistant(raw, context)` 를 제공한다. 문자열을 선택하면 답변 텍스트로 사용한다. 초안이 이력에 먼저 나타나는 서버라면 `readyWhen: { path: ["status"], equals: "done" }` 등 **실제 완료 조건** 또는 callback 검사를 추가한다. 이 필드명과 완료 값은 HAR 에서 확인된 값이 아니다.

## 생성 요청과 템플릿

`request` / `poll.trigger` / `context.send()` 는 `path`, `method` (`GET` 기본 또는 `POST`), `payload` 를 받는다. URL 경로의 `{sessionId}`, `{messageId}`, `{model}`, `{assistantUUID}` 는 URL 인코딩하여 치환한다.

JSON body 에서 치환하려면 **`templatePayload: true` 를 명시**한다. 정확히 `"{messageId}"` 인 값은 숫자 식별자를 유지한다. 치환에 필요한 식별자가 없으면 오류가 발생한다. 일반 사용자 메시지와 세션 payload 의 문자열은 치환하지 않는다.

```ts
// 실제 생성 API가 별도로 존재할 때만 completion(mode=poll)에 추가한다.
const trigger = {
  path: process.env.WEBCHAT_GENERATE_PATH!,
  method: "POST" as const,
  templatePayload: true,
  payload: { session_id: "{sessionId}", message_id: "{messageId}" },
};
```

`createSessionPath`, `appendMessagePath`, `sessionIdPath` 로 경로/세션 ID 위치를 변경할 수 있다. 기본 경로가 `/` 로 시작하므로 서버 root 기준이다. prefix 가 필요하면 전체 경로를 명시하거나 상대 경로를 지정한다.

## Callback

```ts
const ai = createWebChatAIProvider({
  baseURL: process.env.WEBCHAT_BASE_URL!,
  defaultModel: process.env.WEBCHAT_MODEL!,
  webChat: {
    assistantUUID: process.env.WEBCHAT_ASSISTANT_UUID!,
    completion: {
      mode: "custom",
      async complete(context) {
        // context.send는 동일 인증/header/전체 timeout/signal을 사용해 JSON을 읽는다.
        return context.send({ path: process.env.WEBCHAT_ANSWER_PATH! });
      },
    },
    extractAssistant(raw) {
      // 이 schema는 예시다. 실제 서버의 완료 여부와 응답 구조를 검사한다.
      const value = raw as { done?: boolean; answer?: string };
      return value.done && typeof value.answer === "string"
        ? { text: value.answer }
        : undefined;
    },
  },
});
```

callback 에는 `session`, `request`, `lastMessage`, `messageId`, `postedResponses`, `signal` 이 전달된다. 직접 fetch/SDK 를 사용한다면 `context.signal` 도 전달한다. 자체 스트리밍 프로토콜은 callback 에서 처리한 뒤 최종 JSON/assistant 결과를 반환할 수 있다.

## 세션·payload·수명 관리

- 기본 `chat()` 은 매번 새 세션을 만든다. `request.webChat.sessionId` 또는 provider 의 `webChat.sessionId` 를 명시하면 재사용한다. 같은 provider 내 동일 세션의 chat/직접 append 는 완료까지 직렬화한다.
- 재사용 시 새 메시지만 보낸다. 이미 저장한 전체 history 를 다시 보내면 중복 등록된다. 모델과 어시스턴트 지정은 새 세션 생성에 적용되며, 기존 세션의 모델을 자동 변경하지 않는다.
- `request.webChat` 에 `title`, `assistantUUID`, `sessionPayload` 를 지정할 수 있다. `sessionPayload` 는 native 세션 필드를 허용한다.
- 공통 `messages` 는 순서대로 등록한다. `defaultPayload` 는 각 메시지에 적용하고 요청 `payload` 는 마지막 메시지만 덮어쓴다. `payloadMode: "replace"` 는 기본값/공통 메시지 대신 단일 native body 를 보낸다.
- 전체 chat timeout 은 대기열·HTTP·콜백·폴링 시간을 포함하며 기본 60초다. `timeoutMs: 0` 은 제한을 끈다. `http.signal` 및 workflow cancellation 을 전달한다.
- 상태 변경 POST 는 `maxRetries` 와 관계없이 자동 재전송하지 않는다. GET 의 transient 오류/연결 실패만 최대 2회 재시도한다. HTTP redirect 는 오류로 처리한다.
- 응답이 없으면 `AIProviderRequestError.code = "webchat_response_pending"` 과 `responseBody.session_id` 를 제공한다. 세션/메시지를 새로 만들어 자동 재시도하지 않는다.
- `raw` 에는 세션 ID, 생성/등록/완료 원본과 `buffered: true` 가 포함된다. **`chatStream()` 은 JSON 답변 완료 후 1개 chunk 를 전달**하며 토큰 SSE 구현이 아니다. 조기 iterator return 은 HTTP/폴링을 취소한다.
- JSON client 가 SSE 를 받으면 즉시 오류로 처리한다. HAR 에 없는 SSE schema 를 임의로 추측하지 않는다.
- 기본/custom 인증 header 는 debug output 에서 마스킹한다. HAR 원문과 실제 인증값을 저장소에 넣지 않는다.

JSON 파일에서는 `apiType: "webchat"`, `baseURLEnv`, `apiKeyEnv`, `defaultModel`, `webChat` 설정을 사용한다. callback 은 함수이므로 코드 또는 `createAIProviderFromConfigFile({ overrides: { webChat: ... } })` 로 주입한다. 파일의 `webChat` 설정과 overrides 는 shallow merge 한다.

환경변수 기본값: `WEBCHAT_BASE_URL`, `WEBCHAT_API_KEY`, `WEBCHAT_MODEL`, `WEBCHAT_ASSISTANT_UUID`.
