import { describe, expect, it } from "vitest";

import { toOpencodeModelId } from "@slate/shared";

describe("toOpencodeModelId", () => {
  it("leaves opencode ids untouched", () => {
    expect(toOpencodeModelId("opencode/minimax-m3.1-flash-free")).toBe(
      "opencode/minimax-m3.1-flash-free",
    );
    expect(toOpencodeModelId("opencode/beam-free")).toBe("opencode/beam-free");
  });

  it("maps gemini ids to the google provider", () => {
    expect(toOpencodeModelId("gemini/gemini-3.5-flash")).toBe("google/gemini-3.5-flash");
    expect(toOpencodeModelId("gemini/gemini-3.5-flash-lite")).toBe(
      "google/gemini-3.5-flash-lite",
    );
  });

  it("prefixes raw openrouter ids with the openrouter provider", () => {
    expect(toOpencodeModelId("google/gemma-4-26b-a4b-it:free")).toBe(
      "openrouter/google/gemma-4-26b-a4b-it:free",
    );
    expect(toOpencodeModelId("baidu/ernie-5.5-flash-preview:free")).toBe(
      "openrouter/baidu/ernie-5.5-flash-preview:free",
    );
    expect(toOpencodeModelId("liquid/lfm-2.5-2.6b:free")).toBe(
      "openrouter/liquid/lfm-2.5-2.6b:free",
    );
  });

  it("handles the openrouter free router specially", () => {
    expect(toOpencodeModelId("openrouter/free")).toBe("openrouter/openrouter/free");
  });
});
