# Developer Guide

## 목적
이 문서는 `agentic-task-kit` 을 사용하는 개발자가 첫 workflow 를 만들고, memory/AI/renderer 를 연결하고, 배포 가능한 consumer app 을 구성하는 가장 짧은 경로를 정리한다.

## 요구사항
- Node.js 20+
- npm 10+

## 설치
```bash
npm install agentic-task-kit
```

OpenAI-compatible provider 를 사용할 예정이면 추가 설정 파일이나 env 를 준비한다.

## 가장 작은 workflow
```ts
import {
  createCycle,
  createWorkflowInput,
  InMemoryArtifactStore,
  InMemoryMemoryEngine,
  Task,
  workflowInputToPrettyJson,
  type TaskResult,
  type WorkflowContext,
  type WorkflowDefinition
} from "agentic-task-kit";

class CaptureInputTask extends Task {
  name = "captureInput";
  memoryPhase = "PLANNING" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    ctx.log.info("Capturing workflow input");

    await ctx.memory.write({
      shard: "workflow",
      kind: "summary",
      payload: {
        workflowId: ctx.workflowId,
        currentStep: this.name,
        history: [],
        contextSummary: workflowInputToPrettyJson(ctx.input)
      },
      description: "Initial workflow summary",
      keywords: ["workflow", "input", "summary"],
      importance: 0.9,
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      sourceTask: this.name,
      phase: this.memoryPhase,
      taskType: this.memoryTaskType
    });

    return {
      status: "success",
      output: {
        received: true
      }
    };
  }
}

class PublishTask extends Task {
  name = "publish";
  memoryPhase = "EXECUTION" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const retrievedContext = ctx.memoryContext?.assembledContext ?? "none";

    const artifact = await ctx.artifacts.create({
      name: "result.json",
      mimeType: "application/json",
      bytes: new TextEncoder().encode(
        JSON.stringify(
          {
            workflowId: ctx.workflowId,
            retrievedContext
          },
          null,
          2
        )
      )
    });

    ctx.log.success("Published workflow artifact", {
      artifactId: artifact.artifactId
    });

    return {
      status: "success",
      output: {
        artifactId: artifact.artifactId
      }
    };
  }
}

const workflow: WorkflowDefinition = {
  name: "quick-start",
  start: "captureInput",
  end: "end",
  tasks: {
    captureInput: new CaptureInputTask(),
    publish: new PublishTask()
  },
  transitions: {
    captureInput: {
      success: "publish",
      fail: "end"
    },
    publish: {
      success: "end",
      fail: "end"
    }
  }
};

const cycle = createCycle({
  memoryEngine: new InMemoryMemoryEngine(),
  artifactStore: new InMemoryArtifactStore()
});

cycle.register("quick-start", workflow);

const { frame } = await cycle.run(
  "quick-start",
  createWorkflowInput({
    request: "Generate the first AX Workflow artifact."
  }),
);

console.log(frame.status);
```

`Cycle.run()` 반환값에는 `frame` 외에도 run 범위의 memory/artifact/history snapshot 이 포함된다.

```ts
const result = await cycle.run("quick-start", createWorkflowInput(input));

console.log(result.memory.records.length);
console.log(result.artifacts.artifacts.map((artifact) => artifact.name));
console.log(result.history.events.map((event) => event.type));
```

## 핵심 개념
- workflow 는 `WorkflowDefinition` 으로 정의한다.
- task 는 `Task` 를 상속하고 `name`, `memoryPhase`, `memoryTaskType`, `run()` 을 구현한다.
- transition 은 `success`, `fail`, `retry`, `skip` 같은 status 별 다음 상태를 정의한다.
- `Cycle` 은 workflow registry 와 runtime entrypoint 역할을 한다.
- workflow input contract 는 `Map<string, any>` 이고, plain object 는 `createWorkflowInput()` 으로 감싼다.

## task 작성 규칙
모든 task 는 memory metadata 를 명시해야 한다.

```ts
class ExampleTask extends Task {
  name = "example";
  memoryPhase = "EXECUTION" as const;
  memoryTaskType = "workflow" as const;
}
```

- `memoryPhase`
  - `PLANNING`
  - `EXECUTION`
  - `REFLECTION`
  - `RECOVERY`
- `memoryTaskType`
  - `user`
  - `workflow`
  - `debug`
  - `default`

runtime 은 이 값을 보고 `beforeStep()` memory retrieval 과 `afterStep()` memory write 를 자동 적용한다.

## Memory 연결 방식
자동 조회 결과는 `ctx.memoryContext` 로 들어온다.

```ts
const context = ctx.memoryContext?.assembledContext ?? "none";
```

기본 retrieve 로 부족하면 수동 조회를 추가할 수 있다.

```ts
const retrieved = await ctx.memory.retrieve({
  query: "latest workflow summary",
  taskType: "workflow",
  phase: "REFLECTION"
});
```

핵심 결과는 명시적으로 summary memory 로 저장하는 편이 좋다.

```ts
await ctx.memory.write({
  shard: "workflow",
  kind: "summary",
  payload: {
    workflowId: ctx.workflowId,
    currentStep: "reflect",
    history: [],
    contextSummary: "Validated execution summary"
  },
  description: "Reflection summary",
  importance: 0.88,
  workflowId: ctx.workflowId,
  runId: ctx.runId,
  sourceTask: "reflect",
  phase: "REFLECTION",
  taskType: "workflow"
});
```

메모리 상세 규칙은 [memory-guide.md](./memory-guide.md) 를 본다.

## AI provider 연결
OpenAI-compatible provider 를 붙이면 task 내부에서 `ctx.ai.chat()` 과 `ctx.ai.chatStream()` 을 사용할 수 있다.

```ts
import {
  createCycle,
  createOpenAICompatibleChatProvider
} from "agentic-task-kit";

const cycle = createCycle({
  aiProvider: createOpenAICompatibleChatProvider({
    providerName: "openai",
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-5.2",
    timeoutMs: 20_000,
    maxRetries: 2
  })
});
```

HTTP 요청이 실패하면 `AIProviderRequestError` 가 throw 된다. 이 error 에는 `status`, `responseBody`, `requestId`, `originalError` 가 들어 있으니 catch 후 그대로 로깅하면 원인 추적이 쉽다.

설정 파일 경로를 쓰고 싶으면:

```ts
import {
  createCycle,
  createOpenAICompatibleChatProviderFromConfigFile
} from "agentic-task-kit";

const cycle = createCycle({
  aiProvider: createOpenAICompatibleChatProviderFromConfigFile({
    configPath: "./cycle.config.json"
  })
});
```

provider 문서는 [openai-chat-api.md](./openai-chat-api.md) 를 본다.

## All-in-one npm 패키지 빌드
배포용으로는 runtime dependency 를 비운 publish artifact 를 `.npm-package/` 아래에 만들고, `dist/**/*.map` source map 파일은 포함하지 않는다.

```bash
npm run build:all-in-one
npm run publish:all-in-one:dry-run
```

실제 publish 는 다음 스크립트다.

```bash
npm run publish:all-in-one
```

## GitHub Actions publish automation
repository secret `NPM_AUTH_TOKEN` 을 등록하면 `.github/workflows/npm-publish.yml` 로 같은 all-in-one artifact 를 GitHub Actions 에서 publish 할 수 있다.

전체 release 절차와 실패 대응은 [release-guide.md](./release-guide.md) 를 본다.

- trigger:
  - `workflow_dispatch`
  - `v*` tag push
- versioning:
  - `workflow_dispatch` publish 는 `version_bump` 입력을 받고 기본값은 `patch` 다.
  - publish 전 `package.json` / `package-lock.json` version 을 올리고, 성공 후 release commit 과 `v<version>` tag 를 origin 에 push 한다.
- gate:
  - `npm ci`
  - `npm run typecheck`
  - `npm test`
  - `npm run build:all-in-one`
  - `npm pack ./.npm-package`
- 인증:
  - workflow 는 `secrets.NPM_AUTH_TOKEN` 을 `NODE_AUTH_TOKEN` 으로 매핑해 npm registry 인증에 사용한다.
- 안전장치:
  - manual publish 는 default branch 에서만 허용된다.
  - tag publish 는 `v${package.json.version}` 일치 여부를 검사한다.
  - `github-actions[bot]` 가 만든 tag push run 은 중복 publish 를 피하기 위해 skip 한다.

## AI task 에 memory context 넣기
memory 조회는 자동이지만, AI 프롬프트 주입은 task 코드가 직접 한다.

```ts
const completion = await ctx.ai.chat({
  messages: [
    {
      role: "developer",
      content: "Summarize the workflow state for the next execution step."
    },
    {
      role: "user",
      content:
        `Input: ${workflowInputToPrettyJson(ctx.input)}\n\n` +
        `Retrieved memory:\n${ctx.memoryContext?.assembledContext ?? "none"}`
    }
  ]
});
```

긴 응답이나 생성 과정을 바로 보여주고 싶으면 `chatStream()` 을 사용한다.

```ts
const stream = await ctx.ai.chatStream({
  messages: [
    {
      role: "user",
      content: "Generate the implementation plan."
    }
  ]
});

let output = "";
for await (const chunk of stream) {
  output += chunk.deltaText;
}

const finalResponse = await stream.finalResponse;
```

## renderer 연결
CLI observer 를 붙이면 workflow 상태를 바로 볼 수 있다.

```ts
import { createCLIRenderer, createCycle } from "agentic-task-kit";

const renderer = createCLIRenderer({
  enabled: true,
  mode: "ink",
  logLevel: "info"
});

const cycle = createCycle({
  observers: [renderer]
});
```

지원 모드:
- `compact`
- `line`
- `ink`
- `jsonl`
- `plain`

`ink` mode 는 좌측 workflow/task history, 우측 task/provider debug log 패널을 제공한다.

## run options
run 시점에는 `rag`, `memoryInjection`, 추가 observer 를 넣을 수 있다.

```ts
await cycle.run("quick-start", createWorkflowInput(input), {
  rag: [
    {
      id: "policy",
      text: "The first release must stay sequential."
    }
  ],
  memoryInjection: [
    {
      shard: "system",
      kind: "summary",
      payload: {
        policies: ["Prefer observable execution"],
        constraints: ["Do not enable parallel transition in MVP"]
      },
      description: "System execution policy",
      importance: 0.95,
      phase: "PLANNING",
      taskType: "default",
      sourceTask: "seed.system"
    }
  ]
});
```

## build 와 package 검증
consumer-facing 배포 산출물은 single-file ESM bundle 이다.

```bash
npm run typecheck
npm test
npm run build
node -e "import('./dist/index.js')"
```

## 추천 문서 순서
1. 이 문서로 workflow/task 기본 형태를 잡는다.
2. [consumer-example.md](./consumer-example.md) 로 최소 실행 예제를 본다.
3. [memory-guide.md](./memory-guide.md) 로 retrieval/write/lifecycle 를 확인한다.
4. [openai-chat-api.md](./openai-chat-api.md) 로 provider 설정을 붙인다.
5. [local-setup.md](./local-setup.md) 로 로컬 검증 명령을 확인한다.
