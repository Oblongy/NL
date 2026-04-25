import test from "node:test";
import assert from "node:assert/strict";
import { getUserGraphicUploadResponseAttrs } from "./http-server.js";

test("getUserGraphicUploadResponseAttrs infers side panel attrs from Upload.aspx field name", () => {
  const attrs = getUserGraphicUploadResponseAttrs("", "41144", "png", "sideImage");

  assert.deepEqual(attrs, {
    s: "41144",
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
