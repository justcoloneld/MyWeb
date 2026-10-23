import test from "node:test";
import assert from "node:assert/strict";
import { parseDestination, ProxyError } from "../server/proxy.js";

test("accepts a public HTTP(S) URL and retains its browser fragment", () => {
  const destination = parseDestination("https://example.com/docs?q=one#section");
  assert.equal(destination.protocol, "https:");
  assert.equal(destination.hostname, "example.com");
  assert.equal(destination.pathname, "/docs");
  assert.equal(destination.hash, "#section");
});

test("rejects non-web protocols", () => {
  assert.throws(() => parseDestination("file:///etc/passwd"), (error) => {
    return error instanceof ProxyError && error.status === 400;
  });
});

test("rejects embedded credentials", () => {
  assert.throws(() => parseDestination("https://user:password@example.com/"), (error) => {
    return error instanceof ProxyError && error.code === "ECREDENTIALS";
  });
});

test("blocks local hostnames and private or reserved addresses", () => {
  for (const address of [
    "http://localhost/",
    "http://router/",
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/",
    "http://[::1]/",
    "http://printer.local/",
  ]) {
    assert.throws(() => parseDestination(address), (error) => {
      return error instanceof ProxyError && error.status === 403;
    }, address);
  }
});

test("rejects oversized destination strings", () => {
  const oversized = `https://${"a".repeat(4_100)}.com`;
  assert.throws(() => parseDestination(oversized), (error) => {
    return error instanceof ProxyError && error.status === 400;
  });
});
