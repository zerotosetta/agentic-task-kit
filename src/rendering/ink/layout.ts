import { truncateText, type RendererState } from "../../renderer-model.js";
import { LEFT_MIN_WIDTH, RIGHT_MIN_WIDTH, type InkPane } from "./model.js";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeBottomColumns(columns: number): { leftWidth: number; rightWidth: number } {
  const total = Math.max(columns, LEFT_MIN_WIDTH + RIGHT_MIN_WIDTH + 1);
  const leftWidth = clamp(Math.floor(total * 0.48), LEFT_MIN_WIDTH, total - RIGHT_MIN_WIDTH - 1);
  const rightWidth = total - leftWidth - 1;
  return {
    leftWidth,
    rightWidth,
  };
}

export function padLine(value: string, width: number): string {
  const clipped = truncateText(value, width);
  return clipped.length >= width ? clipped : clipped.padEnd(width, " ");
}

export function buildHeaderLine(state: RendererState, columns: number): string {
  const text =
    `Cycle Ink  workflow=${state.workflowId ?? "-"}  status=${state.status ?? "running"}  current=${state.currentTask ?? "-"}  ` +
    `art=${state.artifactCount} mem=${state.memoryWrites} retry=${state.retryCount} err=${state.errorCount}`;
  return padLine(text, columns);
}

export function buildFooterLine(
  columns: number,
  focusedPane: InkPane,
  rightAutoFollow: boolean,
): string {
  const text = `Tab pane  up/down,j/k scroll  PgUp/PgDn page  Home/End,g/G edge  q quit  focus=${focusedPane}  follow=${rightAutoFollow ? "on" : "off"}`;
  return padLine(text, columns);
}

export function withTitle(title: string, width: number, focused = false): string {
  return padLine(`${focused ? ">" : " "} ${title}`, width);
}

export function visibleWindow(lines: string[], start: number, size: number): string[] {
  if (size <= 0) {
    return [];
  }

  return lines.slice(start, start + size);
}

export function maxScroll(lineCount: number, viewportSize: number): number {
  return Math.max(0, lineCount - viewportSize);
}
