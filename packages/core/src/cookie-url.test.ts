import { describe, expect, test } from "vitest";
import { cookieUrlFor } from "./cookie-url.js";

describe("cookieUrlFor", () => {
  test("a secure cookie yields an https:// url", () => {
    expect(
      cookieUrlFor({ domain: "example.com", path: "/app", secure: true }),
    ).toBe("https://example.com/app");
  });

  test("an insecure cookie yields an http:// url", () => {
    expect(
      cookieUrlFor({ domain: "example.com", path: "/app", secure: false }),
    ).toBe("http://example.com/app");
  });

  test("an unset secure flag yields an http:// url", () => {
    expect(cookieUrlFor({ domain: "example.com", path: "/app" })).toBe(
      "http://example.com/app",
    );
  });

  test("a leading-dot domain is stripped", () => {
    expect(cookieUrlFor({ domain: ".example.com", path: "/", secure: true })).toBe(
      "https://example.com/",
    );
  });

  test("a missing path defaults to /", () => {
    expect(cookieUrlFor({ domain: "example.com", secure: true })).toBe(
      "https://example.com/",
    );
  });

  test("a missing domain yields null", () => {
    expect(cookieUrlFor({ path: "/app", secure: true })).toBeNull();
  });

  test("an empty domain yields null", () => {
    expect(cookieUrlFor({ domain: "", path: "/app", secure: true })).toBeNull();
  });
});
