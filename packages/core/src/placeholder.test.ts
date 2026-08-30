import { expect, test } from "vitest";
import { CORE_PLACEHOLDER } from "./index.js";

test("core placeholder is exported", () => {
  expect(CORE_PLACEHOLDER).toBe(true);
});
