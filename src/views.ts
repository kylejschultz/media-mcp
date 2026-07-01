import { apps } from "./config.js";

export type ViewTone = "ok" | "info" | "warning" | "error";

export type ViewState =
  | {
      kind: "loading";
      label: string;
      detail?: string;
    }
  | {
      kind: "success";
      detail?: string;
    }
  | {
      kind: "empty";
      label: string;
      detail?: string;
    }
  | {
      kind: "partial_failure";
      label: string;
      detail?: string;
      warnings: unknown[];
    }
  | {
      kind: "error";
      label: string;
      detail?: string;
      errors: unknown[];
    }
  | {
      kind: "confirm";
      label: string;
      detail?: string;
      actionId: string;
    };

export type ViewMetric = {
  label: string;
  value: string | number;
  tone?: ViewTone;
};

export type ViewItem = {
  label: string;
  value?: string | number | boolean;
  detail?: string;
  tone?: ViewTone;
  media?: ViewMedia;
};

export type ViewMedia = {
  type: "image";
  url: string;
  alt?: string;
};

export type ViewAction = {
  id: string;
  label: string;
  kind: "preview" | "submit" | "external";
  disabled?: boolean;
  payload?: Record<string, unknown>;
};

export type RequestDraftOption = {
  label: string;
  value: string;
  description?: string;
};

export type RequestDraftField = {
  id: string;
  label: string;
  type: "select" | "checkbox";
  required?: boolean;
  value?: string | number | boolean | string[] | number[];
  placeholder?: string;
  options?: RequestDraftOption[];
};

export type ViewCard = {
  id: string;
  title: string;
  tone?: ViewTone;
  media?: ViewMedia;
  metrics?: ViewMetric[];
  items?: ViewItem[];
  actions?: ViewAction[];
};

export type MediaView = {
  schema: "media-mcp.view.v1";
  title: string;
  summary: string;
  state?: ViewState;
  cards: ViewCard[];
};

export function mediaView(title: string, summary: string, cards: ViewCard[]): MediaView {
  return { schema: "media-mcp.view.v1", title, summary, cards };
}

export function viewState(args: {
  empty?: boolean;
  emptyLabel?: string;
  emptyDetail?: string;
  warnings?: unknown[];
  errors?: unknown[];
  confirmActionId?: string;
  confirmLabel?: string;
  confirmDetail?: string;
  successDetail?: string;
}): ViewState {
  const errors = args.errors ?? [];
  if (errors.length > 0) {
    return {
      kind: "error",
      label: "Action failed",
      detail: String(errors[0] ?? ""),
      errors,
    };
  }

  const warnings = args.warnings ?? [];
  if (warnings.length > 0) {
    return {
      kind: "partial_failure",
      label: "Completed with warnings",
      detail: String(warnings[0] ?? ""),
      warnings,
    };
  }

  if (args.empty) {
    return {
      kind: "empty",
      label: args.emptyLabel ?? "Nothing to show",
      detail: args.emptyDetail,
    };
  }

  if (args.confirmActionId) {
    return {
      kind: "confirm",
      label: args.confirmLabel ?? "Confirm action",
      detail: args.confirmDetail,
      actionId: args.confirmActionId,
    };
  }

  return {
    kind: "success",
    detail: args.successDetail,
  };
}

export function withViewState(view: MediaView, state: ViewState): MediaView {
  return { ...view, state };
}

export function countTone(count: number, warningAt = 1): ViewTone {
  return count >= warningAt ? "warning" : "ok";
}

export function healthTone(warnings: unknown[] = []): ViewTone {
  return warnings.length > 0 ? "warning" : "ok";
}

export function serviceLabel(service: string) {
  return apps.find((app) => app.name === service)?.label ?? service;
}
