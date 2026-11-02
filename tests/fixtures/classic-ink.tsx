import { render } from "ink-testing-library";
import assert from "node:assert/strict";
import React from "react";
import { InkRendererScreen } from "../../src/ink-renderer.js";
import { createInitialRendererState } from "../../src/renderer-model.js";

const instance = render(
  React.createElement(InkRendererScreen, {
    state: createInitialRendererState(),
    columns: 100,
    rows: 24,
    finalStatus: undefined,
    useColor: false,
    colorTheme: { debug: "gray", info: "cyan", warn: "yellow", error: "red", success: "green" },
  }),
);
try {
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.match(instance.lastFrame() ?? "", /workflow events are waiting/);
} finally {
  instance.unmount();
}
process.stdout.write("classic JSX passed\n");
