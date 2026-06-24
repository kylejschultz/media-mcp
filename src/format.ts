import type { AnyRecord } from "./types.js";

export function bytes(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

export function itemTitle(record: AnyRecord) {
  return firstString(
    record.title,
    record.sourceTitle,
    record.movie?.title,
    record.series?.title,
    record.artist?.artistName,
    record.album?.title,
    record.name,
    record.filename,
    record.nzb_name,
  ) ?? "unknown";
}

export function comparableTitle(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function timestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function completedAfterFailure(failure: AnyRecord, items: AnyRecord[]) {
  const failedAt = timestamp(failure.date);
  const failedTitle = comparableTitle(failure.title);
  if (!failedAt || !failedTitle) return undefined;

  return items.find((item) => {
    const completedAt = timestamp(item.date);
    if (item.successful !== true || completedAt === undefined || completedAt <= failedAt) return false;
    return comparableTitle(item.title) === failedTitle;
  });
}
