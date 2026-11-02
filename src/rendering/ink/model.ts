import { type RendererState } from "../../renderer-model.js";
import type { ResolvedTaskLogColorTheme } from "../../types.js";

export type InkPane = "left" | "right";

export type InkUIState = {
  focusedPane: InkPane;
  leftScroll: number;
  rightScroll: number;
  rightAutoFollow: boolean;
};

export type InkUIAction =
  | { type: "focus.toggle" }
  | { type: "scroll.line"; delta: number }
  | { type: "scroll.page"; delta: number }
  | { type: "scroll.start" }
  | { type: "scroll.end" }
  | { type: "sync"; leftMaxScroll: number; rightMaxScroll: number };

export type InkScrollMetrics = {
  leftMaxScroll: number;
  rightMaxScroll: number;
  pageSize: number;
};

export type InkRendererScreenProps = {
  state: RendererState;
  columns: number;
  rows: number;
  finalStatus: "success" | "fail" | undefined;
  useColor: boolean;
  colorTheme: ResolvedTaskLogColorTheme;
  onInterrupt?: () => void;
  onQuit?: () => void;
};

export const DEFAULT_COLUMNS = 100;

export const DEFAULT_ROWS = 24;

export const LEFT_MIN_WIDTH = 36;

export const RIGHT_MIN_WIDTH = 42;

export const HISTORY_BUFFER_SIZE = 240;

export const TIMELINE_BUFFER_SIZE = 480;

export const TASK_BOX_INNER_WIDTH = 16;

export type InkInputKey = {
  ctrl?: boolean;
  meta?: boolean;
  name?: string;
  sequence?: string;
  tab?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
};
