import { expect, test } from "vitest";
import { isWorldName, parseWorldFilePath, parseWorldMeta } from "./worldPackage.ts";

/** The shape the pipeline wrote for the first real draft (2026-09-29), shortened. */
function draftMeta(): Record<string, unknown> {
  return {
    package_format: "provisional-m0",
    world_id: "b9b91f9e-b9cd-4e2b-8c64-167fd390eced",
    model: "marble-1.0-draft",
    frame: "marble_raw_opencv",
    metric_scale_factor: null,
    ground_plane_offset: null,
    files: { splats_500k: "splats_500k.spz", pano: "pano.png", source_photo: "source.jpg" },
  };
}

test("reads a draft's meta.json", () => {
  const meta = parseWorldMeta(draftMeta());

  expect(meta.worldId).toBe("b9b91f9e-b9cd-4e2b-8c64-167fd390eced");
  expect(meta.frame).toEqual({
    frame: "marble_raw_opencv",
    metricScaleFactor: null,
    groundPlaneOffset: null,
  });
  expect(meta.files.splats_500k).toBe("splats_500k.spz");
});

test("reads metric data when present", () => {
  const json = { ...draftMeta(), metric_scale_factor: 1.5, ground_plane_offset: 0.8 };

  expect(parseWorldMeta(json).frame.metricScaleFactor).toBe(1.5);
});

test.each([
  ["a missing frame", { frame: undefined }, "frame is missing"],
  ["a scale given as text", { metric_scale_factor: "1.5" }, "must be a number or null"],
  ["a scale of zero", { metric_scale_factor: 0 }, "must be above 0"],
  ["a negative scale", { metric_scale_factor: -1 }, "must be above 0"],
  ["a file path with a folder", { files: { splats_500k: "../secret.spz" } }, "not a plain file"],
  ["files that are not an object", { files: ["splats.spz"] }, "files is not an object"],
])("refuses %s", (_label, change, message) => {
  expect(() => parseWorldMeta({ ...draftMeta(), ...change })).toThrow(message);
});

test("world names follow the pipeline's --name rule", () => {
  expect(isWorldName("living-room-draft")).toBe(true);
  expect(isWorldName("Living-Room")).toBe(false);
  expect(isWorldName("-draft")).toBe(false);
});

test("splits a world file path", () => {
  expect(parseWorldFilePath("/worlds/living-room-draft/meta.json")).toEqual({
    name: "living-room-draft",
    file: "meta.json",
  });
});

test.each([
  "/worlds/../secret.txt",
  "/worlds/living-room-draft/../../secret.txt",
  "/worlds/living-room-draft/%2e%2e",
  "/worlds/living-room-draft/.hidden",
  "/worlds/Living-Room/meta.json",
  "/worlds/living-room-draft/sub/meta.json",
  "/worlds/living-room-draft/",
  "/elsewhere/living-room-draft/meta.json",
])("refuses the path %s", (path) => {
  expect(parseWorldFilePath(path)).toBeNull();
});
