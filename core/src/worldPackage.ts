/** A world package is one folder per world under worlds/, described by its meta.json. */

import type { FrameMetadata } from "./frames.ts";

/** The same rule the pipeline applies to --name. */
const WORLD_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** A plain file name: no folders, and it cannot start with a dot. */
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** Splat file roles from most to least detail. */
const SPLAT_ROLES = ["splats_full_res", "splats_500k", "splats_100k"];

export interface WorldMeta {
  worldId: string;
  frame: FrameMetadata;
  /** Package files by role, for example "splats_500k" to "splats_500k.spz". */
  files: Record<string, string>;
}

export function isWorldName(name: string): boolean {
  return WORLD_NAME.test(name);
}

export function isPlainFileName(name: string): boolean {
  return FILE_NAME.test(name);
}

export function parseWorldMeta(json: unknown): WorldMeta {
  const meta = asRecord(json, "meta.json");
  const files = asRecord(meta.files, "meta.json files");
  const checkedFiles: Record<string, string> = {};
  for (const [role, fileName] of Object.entries(files)) {
    if (typeof fileName !== "string" || !FILE_NAME.test(fileName)) {
      throw new Error(`meta.json: files.${role} is not a plain file name`);
    }
    checkedFiles[role] = fileName;
  }
  const metricScaleFactor = numberOrNull(meta, "metric_scale_factor");
  if (metricScaleFactor !== null && metricScaleFactor <= 0) {
    throw new Error("meta.json: metric_scale_factor must be above 0");
  }
  return {
    worldId: requireString(meta, "world_id"),
    frame: {
      frame: requireString(meta, "frame"),
      metricScaleFactor,
      groundPlaneOffset: numberOrNull(meta, "ground_plane_offset"),
    },
    files: checkedFiles,
  };
}

/** The most detailed splat file the package has. */
export function pickSplatFile(meta: WorldMeta): string {
  for (const role of SPLAT_ROLES) {
    const fileName = meta.files[role];
    if (fileName !== undefined) {
      return fileName;
    }
  }
  throw new Error(`meta.json lists no splat file (${SPLAT_ROLES.join(", ")})`);
}

/** Splits "/worlds/<name>/<file>" into its parts, or returns null for any other path. */
export function parseWorldFilePath(urlPath: string): { name: string; file: string } | null {
  const parts = urlPath.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "worlds") {
    return null;
  }
  const name = parts[2] ?? "";
  const file = parts[3] ?? "";
  if (!isWorldName(name) || !FILE_NAME.test(file)) {
    return null;
  }
  return { name, file };
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(meta: Record<string, unknown>, key: string): string {
  const value = meta[key];
  if (typeof value !== "string") {
    throw new Error(`meta.json: ${key} is missing or not text`);
  }
  return value;
}

function numberOrNull(meta: Record<string, unknown>, key: string): number | null {
  const value = meta[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`meta.json: ${key} must be a number or null`);
  }
  return value;
}
