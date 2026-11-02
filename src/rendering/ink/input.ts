import { clamp } from "./layout.js";
import type { InkInputKey, InkScrollMetrics, InkUIAction, InkUIState } from "./model.js";

export function reduceInkUIState(
  state: InkUIState,
  action: InkUIAction,
  metrics: InkScrollMetrics,
): InkUIState {
  const next = { ...state };
  const pane = state.focusedPane;
  const scrollKey = pane === "left" ? "leftScroll" : "rightScroll";
  const maxForPane = pane === "left" ? metrics.leftMaxScroll : metrics.rightMaxScroll;

  const setScroll = (value: number): void => {
    next[scrollKey] = clamp(value, 0, maxForPane);
    if (pane === "right") {
      next.rightAutoFollow = next.rightScroll >= metrics.rightMaxScroll;
    }
  };

  switch (action.type) {
    case "focus.toggle":
      next.focusedPane = pane === "left" ? "right" : "left";
      return next;
    case "scroll.line":
      setScroll(next[scrollKey] + action.delta);
      return next;
    case "scroll.page":
      setScroll(next[scrollKey] + action.delta * metrics.pageSize);
      return next;
    case "scroll.start":
      setScroll(0);
      return next;
    case "scroll.end":
      setScroll(maxForPane);
      return next;
    case "sync":
      next.leftScroll = clamp(next.leftScroll, 0, action.leftMaxScroll);
      next.rightScroll = next.rightAutoFollow
        ? action.rightMaxScroll
        : clamp(next.rightScroll, 0, action.rightMaxScroll);
      next.rightAutoFollow = next.rightScroll >= action.rightMaxScroll;
      return next;
  }
}

export function isInkInterruptInput(input: string, key: InkInputKey): boolean {
  if (input === "\u0003" || key.sequence === "\u0003") {
    return true;
  }

  return key.ctrl === true && (input.toLowerCase() === "c" || key.name === "c");
}

export function isInkQuitInput(input: string, key: InkInputKey): boolean {
  if (key.ctrl === true || key.meta === true) {
    return false;
  }

  return input.toLowerCase() === "q";
}
