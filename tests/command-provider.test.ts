import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AIProviderRequestError,
  Task,
  createAIProvider,
  createAIProviderFromConfigFile,
  createCommandAIProvider,
  createCycle,
  createWorkflowInput,
  type AIChatRequest,
  type CommandProviderSettings,
  type WorkflowContext,
} from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const request = (content = "hello"): AIChatRequest => ({
  messages: [{ role: "user", content }],
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cycle-command-한글 "));
  cleanups.push(async () => {
    if (
      !resolve(root).startsWith(resolve(tmpdir()) + sep) ||
      !basename(root).startsWith("cycle-command-")
    )
      throw new Error("Unexpected fixture cleanup path.");
    await rm(root, { recursive: true, force: true });
  });
  const script = join(root, "fixture.mjs");
  await writeFile(
    script,
    `
import {appendFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const args = process.argv.slice(2);
const mode = args.shift();
if(mode === 'echo' || mode === '-p') process.stdout.write(args.at(-1) ?? '');
else if(mode === 'inspect') process.stdout.write(JSON.stringify({args,cwd:process.cwd(),visible:process.env.CYCLE_FIXTURE,removed:process.env.CYCLE_REMOVED,path:process.env.PATH}));
else if(mode === 'stdin') { const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk); process.stdout.write(Buffer.concat(chunks)); }
else if(mode === 'fail') {if(args[0]==='--count') appendFileSync(args[1],'called;');process.stdout.write('partial');process.stderr.write('diagnostic');process.exitCode=7;}
else if(mode === 'stderr') {process.stderr.write('diagnostic');process.stdout.write('answer');}
else if(mode === 'json') process.stdout.write(JSON.stringify({answer:args.at(-1),model:'cli-model',usage:{totalTokens:12}}));
else if(mode === 'utf8') {const b=Buffer.from('한글🙂');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),20);}
else if(mode === 'overflow') {process.stdout.write('x'.repeat(1024));process.stderr.write('y'.repeat(1024));setInterval(()=>{},1000);}
else if(mode === 'wait' || mode === 'tree') {
 const child=mode==='tree'?spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}):undefined;
 writeFileSync(args[0],JSON.stringify({pid:process.pid,childPid:child?.pid}));
 setInterval(()=>{},1000);
}
else throw new Error('unknown fixture mode');
`,
  );
  const provider = (
    mode = "echo",
    extra: Partial<CommandProviderSettings> = {},
  ) =>
    createCommandAIProvider({
      command: {
        executable: process.execPath,
        args: [script, mode, "-p", "{message}"],
        ...extra,
      },
    });
  return { root, script, provider };
}

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const status = await readFile(`/proc/${pid}/stat`, "utf8");
      if (/^\d+ \(.*\) Z /u.test(status)) return false;
    }
    return true;
  } catch (error) {
    if (
      ["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return false;
    throw error;
  }
}

describe("command provider input and output", () => {
  it("passes Unicode, quotes, newlines and shell syntax as one literal -p argument", async () => {
    const mock = await fixture();
    const text =
      '한글 "quoted"\n& echo INJECTED | $(whoami) `x` %PATH% !PATH! {model}';
    const result = await mock.provider("inspect").chat(request(text));
    expect(JSON.parse(result.outputText).args).toEqual(["-p", text]);
    expect(result.raw).toMatchObject({
      exitCode: 0,
      stderr: "",
      buffered: true,
    });
  });
  it("preserves the exact stdout and keeps stderr separate", async () => {
    const mock = await fixture();
    const text = " answer\n ";
    expect((await mock.provider().chat(request(text))).outputText).toBe(text);
    const response = await mock.provider("stderr").chat(request());
    expect(response.outputText).toBe("answer");
    expect(response.raw).toMatchObject({ stderr: "diagnostic" });
  });
  it("preserves multiple message roles and text content parts", async () => {
    const mock = await fixture();
    const result = await mock.provider().chat({
      messages: [
        { role: "system", content: "rules" },
        { role: "assistant", content: "previous" },
        {
          role: "user",
          content: [
            { type: "input_text", text: "new " },
            { type: "text", text: "question" },
          ],
        },
      ],
    });
    expect(result.outputText).toBe(
      "[system]\nrules\n\n[assistant]\nprevious\n\n[user]\nnew question",
    );
  });
  it("forwards native payload fields and replace without imposing a model schema", async () => {
    const mock = await fixture();
    const provider = createCommandAIProvider({
      defaultPayload: { vendor_default: true },
      command: {
        executable: process.execPath,
        args: [mock.script, "echo", "{message}"],
      },
    });
    const payload = {
      custom: { nested: [1, true] },
      reasoning: { enabled: true },
    };
    expect(
      JSON.parse((await provider.chat({ ...request(), payload })).outputText),
    ).toEqual({
      vendor_default: true,
      messages: request().messages,
      ...payload,
    });
    expect(
      JSON.parse(
        (await provider.chat({ ...request(), payload, payloadMode: "replace" }))
          .outputText,
      ),
    ).toEqual(payload);
  });
  it("supports explicit messages, custom formatting and model argument templates", async () => {
    const mock = await fixture();
    const provider = mock.provider("echo", {
      buildMessage: (input) => `custom:${String(input.payload?.question)}`,
    });
    expect(
      (await provider.chat({ payload: { question: "hello" } })).outputText,
    ).toBe("custom:hello");
    expect((await provider.chat({ command: { message: "" } })).outputText).toBe(
      "",
    );
    const modelProvider = mock.provider("inspect", {
      args: [mock.script, "inspect", "--model={model}", "-p", "{message}"],
    });
    expect(
      JSON.parse(
        (
          await modelProvider.chat({
            ...request("{model}"),
            model: "cli-choice",
          })
        ).outputText,
      ).args,
    ).toEqual(["--model=cli-choice", "-p", "{model}"]);
    await expect(modelProvider.chat(request())).rejects.toThrow(
      "requires a model",
    );
  });
  it("supports stdin for long input and closes stdin for commands that read until EOF", async () => {
    const mock = await fixture();
    const text = "long 한글\n".repeat(10000);
    const provider = mock.provider("stdin", {
      input: "stdin",
      args: [mock.script, "stdin"],
    });
    expect((await provider.chat(request(text))).outputText).toBe(text);
  });
  it("applies cwd and environment overrides without changing the parent environment", async () => {
    const mock = await fixture();
    const previous = process.env.CYCLE_REMOVED;
    process.env.CYCLE_REMOVED = "parent-value";
    try {
      const provider = mock.provider("inspect", {
        cwd: mock.root,
        env: { CYCLE_FIXTURE: "local-value", CYCLE_REMOVED: null },
      });
      const result = JSON.parse((await provider.chat(request())).outputText);
      expect(result).toMatchObject({ cwd: mock.root, visible: "local-value" });
      expect(result.removed).toBeUndefined();
      expect(process.env.CYCLE_REMOVED).toBe("parent-value");
    } finally {
      if (previous === undefined) delete process.env.CYCLE_REMOVED;
      else process.env.CYCLE_REMOVED = previous;
    }
  });
  it("parses structured CLI output with model and usage metadata", async () => {
    const mock = await fixture();
    const response = await mock
      .provider("json", {
        parseOutput: (result) => {
          const parsed = JSON.parse(result.stdout);
          return {
            text: parsed.answer,
            model: parsed.model,
            usage: parsed.usage,
          };
        },
      })
      .chat(request("parsed"));
    expect(response).toMatchObject({
      outputText: "parsed",
      model: "cli-model",
      usage: { totalTokens: 12 },
    });
  });
  it("decodes UTF-8 correctly across stdout byte boundaries", async () => {
    const mock = await fixture();
    expect((await mock.provider("utf8").chat(request())).outputText).toBe(
      "한글🙂",
    );
  });
});

describe("command provider lifecycle", () => {
  it("reports missing executables without attempting an API call", async () => {
    const provider = createCommandAIProvider({
      command: { executable: "cycle-command-definitely-missing" },
    });
    await expect(provider.chat(request())).rejects.toMatchObject({
      code: "ENOENT",
      provider: "command",
    });
  });
  it("reports nonzero exit codes with stdout/stderr and never retries", async () => {
    const mock = await fixture();
    const counter = join(mock.root, "calls.txt");
    await expect(
      mock
        .provider("fail", {
          args: [mock.script, "fail", "--count", counter, "{message}"],
        })
        .chat({ ...request(), http: { maxRetries: 5 } }),
    ).rejects.toMatchObject({
      code: "command_exit_error",
      responseBody: { exitCode: 7, stdout: "partial", stderr: "diagnostic" },
    });
    expect(await readFile(counter, "utf8")).toBe("called;");
  });
  it("times out a running process", async () => {
    const mock = await fixture();
    await expect(
      mock
        .provider("wait", {
          args: [
            mock.script,
            "wait",
            join(mock.root, "timeout.json"),
            "{message}",
          ],
        })
        .chat({ ...request(), http: { timeoutMs: 500 } }),
    ).rejects.toMatchObject({ code: "command_timeout" });
  });
  it("cancels the command and its child process tree", async () => {
    const mock = await fixture();
    const marker = join(mock.root, "tree.json");
    const controller = new AbortController();
    const pending = mock
      .provider("tree", { args: [mock.script, "tree", marker, "{message}"] })
      .chat({
        ...request(),
        http: { signal: controller.signal, timeoutMs: 10000 },
      });
    const rejection = expect(pending).rejects.toMatchObject({
      code: "command_aborted",
    });
    try {
      await expect
        .poll(() =>
          readFile(marker, "utf8").then(
            () => true,
            () => false,
          ),
        )
        .toBe(true);
      const pids = JSON.parse(await readFile(marker, "utf8"));
      controller.abort();
      await rejection;
      await expect.poll(() => alive(pids.pid)).toBe(false);
      await expect.poll(() => alive(pids.childPid)).toBe(false);
    } finally {
      controller.abort();
      await pending.catch(() => undefined);
    }
  }, 15000);
  it("rejects pre-cancelled requests before spawning a process", async () => {
    const mock = await fixture();
    const marker = join(mock.root, "not-started.json");
    await expect(
      mock
        .provider("wait", { args: [mock.script, "wait", marker, "{message}"] })
        .chat({
          ...request(),
          http: { signal: AbortSignal.abort() },
        }),
    ).rejects.toMatchObject({ code: "command_aborted" });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("bounds combined stdout/stderr output and terminates the process", async () => {
    const mock = await fixture();
    const error = await mock
      .provider("overflow", { maxOutputBytes: 1500 })
      .chat(request())
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "command_output_limit" });
    const body = (error as AIProviderRequestError).responseBody as {
      stdout: string;
      stderr: string;
    };
    expect(
      Buffer.byteLength(body.stdout) + Buffer.byteLength(body.stderr),
    ).toBeLessThanOrEqual(1500);
  });
  it("returns one buffered chunk and cancels an unfinished stream on iterator return", async () => {
    const mock = await fixture();
    const stream = await mock.provider().chatStream(request("buffered"));
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      deltaText: "buffered",
      raw: { buffered: true },
    });
    expect((await stream.finalResponse).outputText).toBe("buffered");
    const marker = join(mock.root, "stream.json");
    const waiting = await mock
      .provider("wait", { args: [mock.script, "wait", marker, "{message}"] })
      .chatStream(request());
    const rejection = expect(waiting.finalResponse).rejects.toMatchObject({
      code: "command_aborted",
    });
    try {
      await expect
        .poll(() =>
          readFile(marker).then(
            () => true,
            () => false,
          ),
        )
        .toBe(true);
    } finally {
      await waiting[Symbol.asyncIterator]().return?.();
    }
    await rejection;
  });
});

describe("command provider integration", () => {
  it("supports generic factory, JSON configuration and output callback overrides", async () => {
    const mock = await fixture();
    const configPath = join(mock.root, "provider.json");
    await writeFile(
      configPath,
      JSON.stringify({
        apiType: "command",
        providerName: "cli-test",
        command: {
          executable: process.execPath,
          args: [mock.script, "json", "-p", "{message}"],
        },
      }),
    );
    const provider = createAIProviderFromConfigFile({
      configPath,
      overrides: {
        command: {
          executable: process.execPath,
          parseOutput: (result) => ({ text: JSON.parse(result.stdout).answer }),
        },
      },
    });
    expect(provider.apiType).toBe("command");
    expect((await provider.chat(request("configured"))).outputText).toBe(
      "configured",
    );
  });
  it("works inside a workflow and exposes command monitoring metadata", async () => {
    const mock = await fixture();
    const logs: unknown[] = [];
    class CommandTask extends Task {
      name = "command";
      memoryPhase = "EXECUTION" as const;
      memoryTaskType = "workflow" as const;
      async run(ctx: WorkflowContext) {
        const result = await ctx.ai.chat({ command: { message: "workflow" } });
        return { status: "success" as const, output: result.outputText };
      }
    }
    const cycle = createCycle({
      aiProvider: createAIProvider({
        apiType: "command",
        command: {
          executable: process.execPath,
          args: [mock.script, "echo", "-p", "{message}"],
        },
      }),
      observers: [
        {
          onEvent() {},
          onTaskLog(log) {
            logs.push(log);
          },
        },
      ],
    });
    cycle.register("cli", {
      name: "cli",
      start: "command",
      tasks: { command: new CommandTask() },
      transitions: { command: "end" },
    });
    expect((await cycle.run("cli", createWorkflowInput({}))).frame.status).toBe(
      "success",
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        message: "AI chat request",
        meta: expect.objectContaining({
          apiType: "command",
          prompt: "workflow",
          promptLength: 8,
        }),
      }),
    );
  });
  it("validates missing settings, input format and templates before execution", async () => {
    const mock = await fixture();
    expect(() => createAIProvider({ apiType: "command" })).toThrow(
      "requires command settings",
    );
    expect(() => mock.provider("echo", { maxOutputBytes: 0 })).toThrow(
      "maxOutputBytes",
    );
    await expect(mock.provider().chat({})).rejects.toThrow("requires messages");
    await expect(
      mock.provider().chat({
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", imageUrl: "https://example.invalid" },
            ],
          },
        ],
      }),
    ).rejects.toThrow("multimodal");
    await expect(
      mock.provider("echo", { args: [mock.script] }).chat(request()),
    ).rejects.toThrow("{message}");
    await expect(mock.provider().chat(request("null\0byte"))).rejects.toThrow(
      "NUL",
    );
  });

  it.skipIf(process.platform !== "win32")(
    "resolves npm Node cmd shims through PATH without shell expansion",
    async () => {
      const mock = await fixture();
      const shim = join(mock.root, "bxca.cmd");
      await writeFile(
        shim,
        '@ECHO off\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\fixture.mjs" %*\r\n',
      );
      const provider = createCommandAIProvider({
        command: {
          executable: "bxca",
          env: { Path: mock.root, PATHEXT: ".EXE;.CMD" },
        },
      });
      const text = '한글\n" & %PATH% !X! {message}';
      expect((await provider.chat(request(text))).outputText).toBe(text);
    },
  );
  it.skipIf(process.platform !== "win32")(
    "rejects arbitrary batch wrappers with an actionable error",
    async () => {
      const mock = await fixture();
      const script = join(mock.root, "arbitrary.cmd");
      await writeFile(script, "@echo off\r\necho should-not-run\r\n");
      await expect(
        createCommandAIProvider({ command: { executable: script } }).chat(
          request(),
        ),
      ).rejects.toMatchObject({ code: "command_unsupported_script" });
    },
  );
});
