import { describe, expect, it } from "vite-plus/test";

import { isSafeBaseUrl, safeBaseUrlOrUndefined } from "./baseUrl.ts";

describe("isSafeBaseUrl", () => {
  it("allows https anywhere", () => {
    expect(isSafeBaseUrl("https://api.example.com/v1")).toBe(true);
    expect(isSafeBaseUrl("https://192.168.1.50:8443/v1")).toBe(true);
  });

  it("allows http only on loopback, which is every real local setup", () => {
    for (const url of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:1234/v1",
      "http://[::1]:8080/v1",
      "http://ollama.localhost/v1",
    ]) {
      expect(isSafeBaseUrl(url)).toBe(true);
    }
  });

  it("refuses cleartext to anywhere off the machine", () => {
    // The whole point. Every request carries the key in a header, so this puts
    // it on the wire for anything in between to read.
    for (const url of [
      "http://api.example.com/v1",
      "http://192.168.1.50:8080/v1",
      "http://10.0.0.5/v1",
      "http://evil.test/v1",
    ]) {
      expect(isSafeBaseUrl(url)).toBe(false);
    }
  });

  it("refuses transports that are not http at all", () => {
    for (const url of ["file:///etc/passwd", "data:text/plain,hi", "ftp://example.com"]) {
      expect(isSafeBaseUrl(url)).toBe(false);
    }
  });

  it("refuses anything it cannot parse rather than guessing", () => {
    expect(isSafeBaseUrl("localhost:11434")).toBe(false);
    expect(isSafeBaseUrl("not a url")).toBe(false);
    expect(isSafeBaseUrl("")).toBe(false);
  });
});

describe("safeBaseUrlOrUndefined", () => {
  it("treats absent, blank and unsafe alike, so a bad value falls back to the default", () => {
    expect(safeBaseUrlOrUndefined(undefined)).toBeUndefined();
    expect(safeBaseUrlOrUndefined("   ")).toBeUndefined();
    expect(safeBaseUrlOrUndefined("http://api.example.com/v1")).toBeUndefined();
  });

  it("passes a safe value through, trimmed", () => {
    expect(safeBaseUrlOrUndefined("  https://api.example.com/v1  ")).toBe(
      "https://api.example.com/v1",
    );
  });
});
