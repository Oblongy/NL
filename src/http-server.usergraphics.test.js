import test from "node:test";
import assert from "node:assert/strict";
import { getUserGraphicUploadResponseAttrs, resolveUserDecalAsset } from "./http-server.js";

test("getUserGraphicUploadResponseAttrs infers side panel attrs from Upload.aspx field name", () => {
  const attrs = getUserGraphicUploadResponseAttrs("", "41144", "png", "sideImage");

  assert.deepEqual(attrs, {
    si: "41144",
    sx: "png",
  });
});

test("getUserGraphicUploadResponseAttrs keeps explicit slot mapping when provided", () => {
  const attrs = getUserGraphicUploadResponseAttrs("160", "41144", "jpg", "sideImage");

  assert.deepEqual(attrs, {
    h: "41144",
    hx: "jpg",
  });
});

test("resolveUserDecalAsset aliases persisted swf requests to the stored image upload", () => {
  const resolved = resolveUserDecalAsset("160_54321.swf", {
    pathResolver(filename) {
      return `C:/fake/${filename}`;
    },
    exists(candidate) {
      return candidate === "C:/fake/160_54321.png";
    },
  });

  assert.deepEqual(resolved, {
    filePath: "C:/fake/160_54321.png",
    contentType: "image/png",
  });
});

test("resolveUserDecalAsset preserves an exact swf file when one exists", () => {
  const resolved = resolveUserDecalAsset("160_54321.swf", {
    pathResolver(filename) {
      return `C:/fake/${filename}`;
    },
    exists(candidate) {
      return candidate === "C:/fake/160_54321.swf";
    },
  });

  assert.deepEqual(resolved, {
    filePath: "C:/fake/160_54321.swf",
    contentType: "application/x-shockwave-flash",
  });
});
