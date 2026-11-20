import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.env.npm_execpath;
assert.ok(npm, "Invoke via npm run test:session-service.");
const temp = await mkdtemp(join(tmpdir(), "atk-installed-session-"));
const app = join(temp, "consumer");
const cli = join(app, "node_modules", "agentic-task-kit", "dist", "atk-mcp.js");
const token = randomUUID();
const headers = { authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json, text/event-stream" };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
let running;

function node(args, cwd) {
  return execFileSync(process.execPath, args, {cwd, encoding: "utf8", timeout: 240_000, windowsHide: true});
}

async function serve(options = ["--config", "atk-mcp.json"]) {
  const proc = spawn(process.execPath, [cli, "serve", ...options, "--port", "0"], {
    cwd: app, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: {...process.env, ATK_SERVICE_TOKEN: token},
  });
  const closed = new Promise(resolve => proc.once("close", resolve));
  running = {proc, closed};
  let stderr = "";
  proc.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && proc.exitCode === null && proc.signalCode === null) {
    const match = /ATK HTTP listening at (http:\/\/127\.0\.0\.1:\d+)\r?\n/.exec(stderr);
    if (match) return match[1];
    await delay(30);
  }
  throw new Error("Service startup failed (exit " + proc.exitCode + ", signal " + proc.signalCode + "). " + stderr);
}

async function stop() {
  if (!running) return;
  running.proc.kill("SIGKILL");
  await running.closed;
  running = undefined;
}

async function post(url, value, requestHeaders = headers) {
  return fetch(url, {method: "POST", headers: requestHeaders, body: JSON.stringify(value), signal: AbortSignal.timeout(30_000)});
}

async function web(origin, tool, args) {
  const response = await post(origin + "/api/tools/" + tool, args, {
    "content-type": "application/json", origin, "x-atk-dashboard": "1",
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function connect(origin) {
  let id = 0;
  const rpc = async (method, params) => {
    const response = await post(origin + "/mcp", {jsonrpc: "2.0", id: ++id, method, params});
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.id, id);
    assert.ok(!body.error, JSON.stringify(body));
    return body.result;
  };
  await rpc("initialize", {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "handoff", version: "1"}});
  const ready = await post(origin + "/mcp", {jsonrpc: "2.0", method: "notifications/initialized"});
  assert.equal(ready.status, 202);
  return async (name, args) => {
    const result = await rpc("tools/call", {name, arguments: args});
    const data = JSON.parse(result.content[0].text);
    assert.ok(!result.isError, JSON.stringify(data));
    return data;
  };
}

async function waitFor(call, sessionId, status) {
  const deadline = Date.now() + 120_000;
  let ctx;
  while (Date.now() < deadline) {
    ctx = await call("session_context", {sessionId});
    if (ctx.run?.status === status) return ctx;
    assert.ok(["queued", "running", "interrupted", undefined].includes(ctx.run?.status), JSON.stringify(ctx));
    await delay(70);
  }
  throw new Error("Timed out waiting for " + status + ". Last context: " + JSON.stringify(ctx));
}

async function standaloneAcceptance() {
  const options = ["--state", join(temp, "standalone")];
  let origin = await serve(options);
  let call = await connect(origin);
  const create = title => call("session_create", {title, goal:"Review output", idempotencyKey:title});
  const {sessionId, version:sessionVersion} = await create("Package review");
  const other = await create("Independent session");
  const handoff = {actor:"coordinator", stage:"handoff", reason:"Prepare independent review"};
  await call("session_note", {sessionId, expectedVersion:sessionVersion, summary:"Ready for review", nextAction:"Read the draft", ...handoff});
  const path = "reports/검토.html";
  const revisions = ["<p>초안</p>", "<p>확정</p>", "<p>후속 작업</p>"];
  const publications = [];
  for (const [index, content] of revisions.entries()) {
    const version = index + 1;
    const actor = index === 0 ? "writer" : "reviewer";
    const stage = index === 0 ? "draft" : "review";
    const reason = "Save revision " + version;
    const write = {sessionId, path, content, expectedVersion:index, actor, stage, reason};
    const saved = await call("workspace_write", write);
    assert.equal(saved.sha256, digest(content));
    if (version > 2) continue;
    const role = version === 1 ? "intermediate" : "final";
    const publish = {sessionId, path, version, role, actor, stage, reason, idempotencyKey:"publish-" + version};
    const publication = await call("artifact_publish", publish);
    assert.deepEqual(await call("artifact_publish", publish), publication);
    for (const [key, value] of Object.entries({sessionId, path, version, role, actor, stage, reason})) {
      assert.equal(publication[key], value, key);
    }
    assert.equal(publication.sha256, digest(content));
    const conflict = await post(origin + "/api/tools/artifact_publish", {...publish, reason:"Different request"});
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");
    publications.push(publication);
    if (version === 1) {
      call = await connect(origin);
      const handoffContext = await call("session_context", {sessionId});
      assert.deepEqual(handoffContext.workspacePublications, [publication]);
    }
  }
  await stop();
  origin = await serve(options);
  call = await connect(origin);
  const ctx = await call("session_context", {sessionId});
  const listed = (await call("artifact_list", {sessionId})).publications;
  const ids = rows => rows.map(row => row.publicationId).sort();
  assert.deepEqual(ids(listed), ids(publications));
  assert.deepEqual(ids(ctx.workspacePublications), ids(publications));
  for (const [index, publication] of publications.entries()) {
    const args = {sessionId, publicationId:publication.publicationId};
    const read = await web(origin, "artifact_read", args);
    assert.equal(read.content, revisions[index]);
    assert.equal(digest(read.content), publication.sha256);
    assert.equal((await post(origin + "/api/tools/artifact_read", {...args, sessionId:other.sessionId})).status, 404);
  }
  const all = [];
  let beforeSeq;
  do {
    const page = await call("session_history", {sessionId, beforeSeq, limit:2});
    assert.ok(page.events.length <= 2);
    for (const event of page.events) {
      assert.ok(!all.length || event.seq < all.at(-1).seq);
      all.push(event);
    }
    if (page.nextBeforeSeq !== null) {
      assert.ok(Number.isInteger(page.nextBeforeSeq));
      assert.ok(beforeSeq === undefined || page.nextBeforeSeq < beforeSeq);
    }
    beforeSeq = page.nextBeforeSeq;
  } while (beforeSeq !== null);
  const notes = all.filter(event => event.type === "note_edit");
  assert.equal(notes.length, 1);
  for (const [key, value] of Object.entries(handoff)) assert.equal(notes[0][key], value);
  assert.equal(all.filter(event => event.type === "workspace_write").length, 3);
  assert.equal(all.filter(event => event.type === "artifact_publish").length, 2);
  for (const event of all.filter(row => row.type === "workspace_write" || row.type === "artifact_publish")) {
    assert.equal(event.path, path);
    assert.equal(event.sha256, digest(revisions[event.version - 1]));
    assert.equal(event.actor, event.version === 1 ? "writer" : "reviewer");
    assert.equal(event.stage, event.version === 1 ? "draft" : "review");
    assert.equal(event.reason, "Save revision " + event.version);
  }
  await web(origin, "session_delete", {sessionId, expectedVersion:ctx.session.version});
  for (const [tool, args] of [["artifact_list", {sessionId}], ["session_history", {sessionId}],
    ["artifact_read", {sessionId, publicationId:publications[0].publicationId}]]) {
    assert.equal((await post(origin + "/api/tools/" + tool, args)).status, 404);
  }
  assert.deepEqual((await call("session_list", {})).sessions.map(row => row.sessionId), [other.sessionId]);
  await stop();
}

try {
  await mkdir(app);
  await writeFile(join(app,"package.json"), JSON.stringify({name:"session-regression",version:"1.0.0",private:true,type:"module"}));
  const [packed] = JSON.parse(node([npm, "pack", "./.npm-package", "--pack-destination", temp, "--json"], root));
  node([npm, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", join(temp, packed.filename)], app);
  await writeFile(join(app, "empty.json"), JSON.stringify({stateDirectory:"./empty-state", profiles:{}}));
  const emptyOrigin = await serve(["--config", "empty.json"]);
  assert.deepEqual((await web(emptyOrigin, "session_list", {})).sessions, []);
  await stop();
  await standaloneAcceptance();
  await writeFile(join(app, "pipeline.mjs"), `
import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { definePipeline } from "agentic-task-kit";
const schema = {type:"object", properties:{text:{type:"string"}}, required:["text"], additionalProperties:false};
const step = (key, transform) => ({
  key, revision:"1", description:key, effect:"read", inputSchema:schema, outputSchema:schema,
  async run({text}) {
    appendFileSync(new URL("./workers.log", import.meta.url), JSON.stringify({key,pid:process.pid}) + "\\n");
    if (key === "prepare") {
      const release = new URL("./continue", import.meta.url);
      const deadline = Date.now() + 180_000;
      while (!existsSync(release)) {
        if (Date.now() > deadline) throw new Error("Test did not release worker.");
        await delay(50);
      }
    }
    return {text:transform(text)};
  },
});
export const {descriptor, createWorkflow} = definePipeline({
  key:"two-steps", revision:"1", description:"Prepare and publish text.", inputSchema:schema, outputSchema:schema,
  steps:[step("prepare", s=>s.trim()), step("publish", s=>s+"!")],
});
`);
  node(["--input-type=module", "-e", `
    import {writeFileSync} from "node:fs";
    import {descriptor} from "./pipeline.mjs";
    writeFileSync("atk-mcp.json", JSON.stringify({stateDirectory:"./state",profiles:{
      "two-steps":{module:"./pipeline.mjs",...descriptor,maxSteps:1}
    }}));
  `], app);
  let origin = await serve();
  const firstPid = running.proc.pid;
  assert.equal((await post(origin + "/api/tools/session_list", {}, {"content-type":"application/json"})).status, 401);
  let call = await connect(origin);
  const title = "Quarterly handoff";
  const {sessionId, version} = await call("session_create", {title, goal:"Finish two stages", idempotencyKey:"create"});
  const summary = "First agent prepared the input.";
  const nextAction = "Resume the publication step.";
  await call("session_note", {sessionId, expectedVersion:version, summary, nextAction});
  const file = {sessionId, path:"notes/인계.txt", content:"결과 검토", expectedVersion:0};
  const written = await call("workspace_write", file);
  assert.equal(written.sha256, digest(file.content));
  const start = {sessionId, profile:"two-steps", request:{text:" hello "}, idempotencyKey:"first-run"};
  const {runId} = await call("workflow_start", start);
  call = await connect(origin);
  const findSession = async () => {
    const page = await call("session_list", {query:title});
    assert.deepEqual(page.sessions.map(s=>s.sessionId), [sessionId]);
    return page.sessions[0].sessionId;
  };
  const active = await waitFor(call, await findSession(), "running");
  assert.equal(active.run.runId, runId);
  const busyDelete = await post(origin + "/api/tools/session_delete", {sessionId, expectedVersion: active.session.version});
  assert.equal(busyDelete.status, 409);
  assert.equal((await busyDelete.json()).error.code, "RUN_ACTIVE");
  await stop();
  await writeFile(join(app, "continue"), "continue the detached worker");
  origin = await serve();
  const secondPid = running.proc.pid;
  call = await connect(origin);
  const context = await waitFor(call, await findSession(), "interrupted");
  assert.equal(context.run.checkpointSeq, 1);
  assert.equal(context.session.summary, summary);
  assert.equal(context.session.nextAction, nextAction);
  assert.equal(context.run.runId, runId);
  assert.equal(context.run.status, "interrupted");
  assert.equal(context.files[0].sha256, written.sha256);
  assert.equal((await web(origin, "workspace_read", {sessionId, path:file.path, version:1})).content, file.content);
  assert.equal((await call("workflow_start", start)).runId, runId);
  const other = await call("session_create", {title:"Other", goal:"Separate", idempotencyKey:"other"});
  const scoped = await post(origin + "/api/tools/workflow_results", {sessionId:other.sessionId, runId});
  assert.equal(scoped.status, 404);
  assert.equal((await scoped.json()).error.code, "RUN_NOT_FOUND");
  const resume = context.run.nextAction.arguments;
  assert.equal(context.run.nextAction.tool, "workflow_resume");
  assert.deepEqual(resume, {
    sessionId, runId, expectedCheckpointSeq: context.run.checkpointSeq, expectedInputSha256: context.run.inputSha256,
  });
  assert.match(resume.expectedInputSha256, /^[0-9a-f]{64}$/);
  for (const key of ["expectedCheckpointSeq", "expectedInputSha256"]) {
    const incomplete = {...resume};
    delete incomplete[key];
    const rejected = await post(origin + "/api/tools/workflow_resume", incomplete);
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, "INVALID_ARGUMENT");
  }
  const stale = await post(origin + "/api/tools/workflow_resume", {...resume,expectedInputSha256:"0".repeat(64)});
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "INPUT_SNAPSHOT_MISMATCH");
  const staleHead = await post(origin + "/api/tools/workflow_resume", {...resume, expectedCheckpointSeq: 0});
  assert.equal(staleHead.status, 409);
  assert.equal((await staleHead.json()).error.code, "CHECKPOINT_CONFLICT");
  await call(context.run.nextAction.tool, resume);
  const done = await waitFor(call, sessionId, "completed");
  assert.equal(done.run.checkpointSeq, 2);
  const ref = done.publications[0]?.artifact;
  assert.ok(ref, "Expected a published artifact.");
  const listing = await call("workflow_results", {sessionId,runId});
  assert.ok(listing.artifacts.some(a=>a.id===ref.id && a.sha256===ref.sha256));
  let cursor;
  const chunks = [];
  const seen = new Set();
  do {
    const page = await web(origin, "workflow_results", {sessionId,runId,artifactId:ref.id,cursor,maxBytes:7});
    assert.ok(!seen.has(cursor), "Repeated artifact cursor.");
    seen.add(cursor);
    assert.equal(page.artifact.id, ref.id);
    assert.equal(page.artifact.sha256, ref.sha256);
    chunks.push(Buffer.from(page.data,"base64"));
    cursor = page.nextCursor;
  } while (cursor !== null);
  const bytes = Buffer.concat(chunks);
  assert.equal(digest(bytes), ref.sha256);
  assert.deepEqual(JSON.parse(bytes), {text:"hello!"});
  const steps = (await readFile(join(app,"workers.log"),"utf8")).trim().split(/\r?\n/).map(line=>JSON.parse(line));
  assert.deepEqual(steps.map(step=>step.key), ["prepare","publish"]);
  assert.ok(steps[0].pid !== firstPid && steps[1].pid !== secondPid, "Expected separate worker processes.");
  const beforeDelete = await web(origin, "session_list", {});
  assert.deepEqual(new Set(beforeDelete.sessions.map(row => row.sessionId)), new Set([sessionId, other.sessionId]));
  const staleDelete = await post(origin + "/api/tools/session_delete", {sessionId, expectedVersion: version});
  assert.equal(staleDelete.status, 409);
  await web(origin, "session_delete", {sessionId, expectedVersion: done.session.version});
  await stop();
  origin = await serve();
  assert.deepEqual((await web(origin, "session_list", {})).sessions.map(row => row.sessionId), [other.sessionId]);
  for (const [tool, params] of [
    ["session_context", {sessionId}],
    ["workspace_read", {sessionId, path: file.path, version: 1}],
    ["workflow_results", {sessionId, runId, artifactId: ref.id}],
  ]) {
    assert.equal((await post(origin + "/api/tools/" + tool, params)).status, 404);
  }
  console.log("Installed session service passed client handoff, restart, guarded resume, token-free browser access, artifact verification and scoped deletion. SHA-256: " + ref.sha256);
} finally {
  await stop();
  await rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:150});
}
