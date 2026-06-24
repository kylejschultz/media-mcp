import { apps } from "./config.js";

export type ViewTone = "ok" | "info" | "warning" | "error";

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

export type DiscordComponentOption = {
  label: string;
  value: string;
  description?: string;
};

export type DiscordComponentSpec = {
  container?: {
    accentColor?: string;
  };
  blocks: Array<
    | { type: "text"; text: string }
    | {
        type: "section";
        text?: string;
        texts?: string[];
        accessory?: { type: "thumbnail"; url: string };
      }
    | { type: "separator" }
    | {
        type: "actions";
        buttons?: Array<{
          label: string;
          style?: "primary" | "secondary" | "success" | "danger" | "link";
          callbackData?: string;
          callbackDataKind?: "command" | "callback";
          disabled?: boolean;
        }>;
        select?: {
          type: "string";
          placeholder?: string;
          minValues?: number;
          maxValues?: number;
          callbackDataKind?: "command" | "callback";
          options: DiscordComponentOption[];
        };
      }
  >;
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

export type ComponentView = {
  schema: "media-mcp.view.v1";
  title: string;
  summary: string;
  cards: ViewCard[];
};

export function componentView(title: string, summary: string, cards: ViewCard[]): ComponentView {
  return { schema: "media-mcp.view.v1", title, summary, cards };
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
