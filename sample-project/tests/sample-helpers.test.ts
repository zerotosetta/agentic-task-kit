import assert from "node:assert/strict";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createOutputDirName, resolveOutputPath, serializeRecord } from "../src/sample-files.js";
import {
  resolveHTTPDebugEnabled,
  resolveRendererOptions,
  resolveRequestHeaders,
  withDebugStream,
} from "../src/sample-runtime.js";

test("renderer defaults and explicit settings retain the host contract", () => {
  assert.deepEqual(resolveRendererOptions({}), { enabled: true });
  assert.deepEqual(
    resolveRendererOptions({ CYCLE_LIVE: "0", CYCLE_RENDER_MODE: "ink", CYCLE_LOG_LEVEL: "debug" }),
    { enabled: false, mode: "ink", logLevel: "debug" },
  );
});
test("request headers reject malformed shapes and keep only string values", () => {
  assert.throws(() => resolveRequestHeaders({ CYCLE_REQUEST_HEADERS_JSON: "[]" }), /JSON object/);
  assert.deepEqual(
    resolveRequestHeaders({ CYCLE_REQUEST_HEADERS_JSON: '{"X-Trace":"trace","ignored":1}' }),
    { "X-Trace": "trace" },
  );
  assert.equal(resolveRequestHeaders({}), undefined);
});
test("debug overrides preserve provider settings without mutating the original", () => {
  const stream = new PassThrough();
  const options: {
    httpDebugLogging: { enabled: boolean; includeHeaders: boolean; stream?: PassThrough };
  } = { httpDebugLogging: { enabled: true, includeHeaders: true } };
  const updated = withDebugStream(options, stream);
  assert.equal(updated.httpDebugLogging.stream, stream);
  assert.equal(updated.httpDebugLogging.includeHeaders, true);
  assert.equal("stream" in options.httpDebugLogging, false);
  assert.equal(resolveHTTPDebugEnabled(false, { OPENAI_HTTP_DEBUG: "1" }), false);
  assert.equal(resolveHTTPDebugEnabled(undefined, { OPENAI_HTTP_DEBUG: "YES" }), true);
  stream.destroy();
});
test("native output names preserve Unicode while stripping a Java extension on demand", () => {
  assert.match(
    createOutputDirName(join("한글 폴더", "Orders.java"), { stripJavaExtension: true }),
    /^Orders-\d{4}-/,
  );
  assert.match(
    createOutputDirName(join("한글 폴더", "workspace"), { unique: true }),
    /^workspace-.*-\d+-[a-f0-9]{4}$/,
  );
});
test("memory snapshots keep payloads and normalize absent optional fields to null", () => {
  const payload = { count: 1 };
  const serialized = serializeRecord({ id: "id", payload, importance: 0 });
  assert.equal(serialized.payload, payload);
  assert.equal(serialized.importance, 0);
  assert.equal(serialized.workflowId, null);
  assert.equal(serialized.archivedAt, null);
});

test("generated file paths remain inside their output directory on either platform", () => {
  const output = join(process.cwd(), "generated");
  for (const path of ["../escape", "..\\escape", "C:\\escape", "/escape"])
    assert.throws(() => resolveOutputPath(output, path), /relative|escapes/);
  assert.equal(resolveOutputPath(output, "src/한글.jsp"), join(output, "src", "한글.jsp"));
});
