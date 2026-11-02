import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// Resolve the consuming application's dependency tree, including its overrides.
const consumerRequire = createRequire(resolve(process.cwd(), "package.json"));
const cliRequire = createRequire(consumerRequire.resolve("@leflect-java/cli"));
const { parseTld, loadTldRegistry } = cliRequire("@leflect-java/parser-tld");
const AdmZip = cliRequire("adm-zip");
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<taglib xmlns="http://java.sun.com/xml/ns/javaee">
  <uri>urn:sample:태그</uri>
  <tag><name>review</name><tag-class>com.acme.ReviewTag</tag-class>
    <body-content>JSP</body-content><dynamic-attributes>true</dynamic-attributes>
    <attribute><name>order</name><required>true</required>
      <rtexprvalue>true</rtexprvalue><type>java.lang.String</type></attribute>
  </tag>
</taglib>`;

function verifyTag(entry) {
  assert.equal(entry.uri, "urn:sample:태그");
  assert.equal(entry.tags.length, 1);
  assert.equal(entry.tags[0].name, "review");
  assert.equal(entry.tags[0].handlerClass, "com.acme.ReviewTag");
  assert.equal(entry.tags[0].bodyContent, "JSP");
  assert.equal(entry.tags[0].dynamicAttributes, true);
  assert.deepEqual(entry.tags[0].attributes, [{
    name: "order", required: true, runtimeExpressionValue: true,
    type: "java.lang.String", fragment: undefined,
  }]);
}

test("Leflect preserves TLD tag and attribute contracts with the patched XML parser", () => {
  verifyTag(parseTld(xml));
});

test("Leflect loads compressed JAR taglibs and honors local TLD precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "leflect 한글 jar "));
  try {
    const jar = new AdmZip();
    jar.addFile("META-INF/review.tld", Buffer.from(xml));
    jar.writeZip(join(root, "review tags.jar"));
    const archive = await loadTldRegistry({
      root, autoLoad: true, classpathEntries: ["review tags.jar"],
    });
    assert.deepEqual(archive.diagnostics, []);
    assert.equal(archive.entries.length, 1);
    verifyTag(archive.entries[0]);
    assert.equal(archive.entries[0].sourceKind, "classpath");
    assert.match(archive.entries[0].sourcePath, /review tags\.jar!\/META-INF\/review\.tld$/u);

    await writeFile(join(root, "local.tld"), xml.replace("com.acme.ReviewTag", "com.acme.LocalTag"));
    const local = await loadTldRegistry({
      root, repoFiles: ["local.tld"], autoLoad: true,
      classpathEntries: ["review tags.jar"],
    });
    assert.equal(local.entries.length, 1);
    assert.equal(local.entries[0].tags[0].handlerClass, "com.acme.LocalTag");
    assert.equal(local.entries[0].sourceKind, "repo");
    assert.equal(local.diagnostics[0]?.code, "duplicate-uri");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
