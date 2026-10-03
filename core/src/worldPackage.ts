/** A world package is one folder per world under worlds/, described by its meta.json. */

import type { FrameMetadata } from "./frames.ts";

/** The same rule the pipeline applies to --name. */
const WORLD_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** A plain file name: no folders, and it cannot start with a dot. */
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** Splat detail levels a world address may ask for, from most to least detail. */
export const SPLAT_DETAILS = ["full_res", "500k", "100k"] as const;
export type SplatDetail = (typeof SPLAT_DETAILS)[number];
/** Splat file roles for those levels, most detailed first. */
const SPLAT_ROLES = SPLAT_DETAILS.map((detail) => `splats_${detail}`);

export interface WorldMeta {
  worldId: string;
  frame: FrameMetadata;
  /** Package files by role, for example "splats_500k" to "splats_500k.spz". */
  files: Record<string, string>;
}

export function isWorldName(name: string): boolean {
  return WORLD_NAME.test(name);
}

export function isSplatDetail(value: string): value is SplatDetail {
  return (SPLAT_DETAILS as readonly string[]).includes(value);
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

/**
 * The splat file the package has for `detail`. By default that is the most detailed file;
 * a specific level picks that level, else the most detailed smaller one, and a package with
 * nothing that small falls back to its smallest file. The viewer never loads something more
 * detailed than asked for unless the package offers nothing smaller.
 */
export function pickSplatFile(meta: WorldMeta, detail: SplatDetail = "full_res"): string {
  const wanted = SPLAT_ROLES.indexOf(`splats_${detail}`);
  let smallestTooDetailed: string | undefined;
  for (const [index, role] of SPLAT_ROLES.entries()) {
    const fileName = meta.files[role];
    if (fileName === undefined) {
      continue;
    }
    if (index >= wanted) {
      return fileName;
    }
    smallestTooDetailed = fileName;
  }
  if (smallestTooDetailed !== undefined) {
    return smallestTooDetailed;
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
