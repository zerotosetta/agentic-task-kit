import { Text, useInput } from "ink";
import React, { useEffect, useState, type ReactElement } from "react";
import { inkColorForLevel } from "../../renderer-colors.js";
import { type TimelineRow } from "../../renderer-model.js";
import { buildFlowchartLines } from "./flowchart.js";
import { isInkInterruptInput, isInkQuitInput, reduceInkUIState } from "./input.js";
import {
  buildFooterLine,
  buildHeaderLine,
  clamp,
  computeBottomColumns,
  maxScroll,
  padLine,
  visibleWindow,
  withTitle,
} from "./layout.js";
import type { InkRendererScreenProps, InkUIState } from "./model.js";

export function InkRendererScreen({
  state,
  columns,
  rows,
  finalStatus,
  useColor,
  colorTheme,
  onInterrupt,
  onQuit,
}: InkRendererScreenProps): ReactElement {
  const [uiState, setUiState] = useState<InkUIState>({
    focusedPane: "right",
    leftScroll: 0,
    rightScroll: 0,
    rightAutoFollow: true,
  });

  const { leftWidth, rightWidth } = computeBottomColumns(columns);
  const usableRows = Math.max(rows, 16);
  const footerRows = finalStatus ? 3 : 2;
  const contentRows = Math.max(usableRows - footerRows, 10);
  const flowchartLines = buildFlowchartLines(state, columns);
  const flowchartViewport = clamp(flowchartLines.length, 6, Math.max(6, contentRows - 6));
  const bottomViewport = Math.max(4, contentRows - flowchartViewport - 2);
  const leftLines = state.taskHistory.map((row) => padLine(row.text, leftWidth));
  const rightRows = state.timeline;
  const metrics = {
    leftMaxScroll: maxScroll(leftLines.length, bottomViewport),
    rightMaxScroll: maxScroll(rightRows.length, bottomViewport),
    pageSize: Math.max(1, bottomViewport - 1),
  };

  useEffect(() => {
    setUiState((current) =>
      reduceInkUIState(
        current,
        {
          type: "sync",
          leftMaxScroll: metrics.leftMaxScroll,
          rightMaxScroll: metrics.rightMaxScroll,
        },
        metrics,
      ),
    );
  }, [metrics.leftMaxScroll, metrics.rightMaxScroll, metrics.pageSize]);

  useInput((input, key) => {
    if (isInkInterruptInput(input, key)) {
      onInterrupt?.();
      return;
    }

    if (isInkQuitInput(input, key)) {
      onQuit?.();
      return;
    }

    if (key.tab || input === "\t") {
      setUiState((current) => reduceInkUIState(current, { type: "focus.toggle" }, metrics));
      return;
    }

    if (key.upArrow || input === "k") {
      setUiState((current) =>
        reduceInkUIState(current, { type: "scroll.line", delta: -1 }, metrics),
      );
      return;
    }

    if (key.downArrow || input === "j") {
      setUiState((current) =>
        reduceInkUIState(current, { type: "scroll.line", delta: 1 }, metrics),
      );
      return;
    }

    if (key.pageUp) {
      setUiState((current) =>
        reduceInkUIState(current, { type: "scroll.page", delta: -1 }, metrics),
      );
      return;
    }

    if (key.pageDown) {
      setUiState((current) =>
        reduceInkUIState(current, { type: "scroll.page", delta: 1 }, metrics),
      );
      return;
    }

    if (key.home || input === "g") {
      setUiState((current) => reduceInkUIState(current, { type: "scroll.start" }, metrics));
      return;
    }

    if (key.end || input === "G") {
      setUiState((current) => reduceInkUIState(current, { type: "scroll.end" }, metrics));
    }
  });

  const topPanelLines = [
    withTitle("워크플로우 파이프라인 플로우차트", columns),
    ...visibleWindow(flowchartLines, 0, flowchartViewport),
  ];
  while (topPanelLines.length < flowchartViewport + 1) {
    topPanelLines.push(" ".repeat(columns));
  }

  const bottomTitleLine =
    `${withTitle("워크플로우 task 실행 이력", leftWidth, uiState.focusedPane === "left")}│` +
    `${withTitle(`실행 로그 (${state.timeline.length})`, rightWidth, uiState.focusedPane === "right")}`;

  const leftPanelLines = visibleWindow(leftLines, uiState.leftScroll, bottomViewport);
  const rightPanelRows = rightRows.slice(uiState.rightScroll, uiState.rightScroll + bottomViewport);
  while (leftPanelLines.length < bottomViewport) {
    leftPanelLines.push(" ".repeat(leftWidth));
  }
  while (rightPanelRows.length < bottomViewport) {
    rightPanelRows.push({
      id: `empty:${rightPanelRows.length}`,
      timestamp: 0,
      level: "info",
      source: "task",
      text: "",
    });
  }

  const mergedBottomLines: Array<{
    id: string;
    left: string;
    right: string;
    level: TimelineRow["level"];
  }> = [];
  for (let index = 0; index < bottomViewport; index += 1) {
    const row = rightPanelRows[index];
    mergedBottomLines.push({
      id: row?.id ?? `row:${index}`,
      left: leftPanelLines[index] ?? " ".repeat(leftWidth),
      right: padLine(row?.text ?? "", rightWidth),
      level: row?.level ?? "info",
    });
  }

  return (
    <React.Fragment>
      <Text>{buildHeaderLine(state, columns)}</Text>
      {topPanelLines.map((line, index) => (
        <Text key={`top-${index}`}>{line}</Text>
      ))}
      <Text>{bottomTitleLine}</Text>
      {mergedBottomLines.map((line) => (
        <Text key={line.id}>
          <Text>{line.left}</Text>
          <Text>│</Text>
          {useColor ? (
            <Text color={inkColorForLevel(line.level, colorTheme)}>{line.right}</Text>
          ) : (
            <Text>{line.right}</Text>
          )}
        </Text>
      ))}
      <Text>{buildFooterLine(columns, uiState.focusedPane, uiState.rightAutoFollow)}</Text>
      {finalStatus ? <Text>{padLine(`Final status: ${finalStatus}`, columns)}</Text> : null}
    </React.Fragment>
  );
}
