import { test, expect } from "vitest";
import {
  JSONRPC_VERSION,
  buildRequest,
  buildNotification,
  nextRequestId,
  isJsonRpcResponse,
  isSuccess,
  isFailure,
  isJsonRpcNotification,
  matchResponseById,
  hasErrorCode,
  notificationsByMethod,
} from "./jsonrpc.js";

test("buildRequest sets jsonrpc, id and method and includes params", () => {
  const req = buildRequest("tools/call", { name: "ask" }, "fixed-1");
  expect(req).toEqual({
    jsonrpc: JSONRPC_VERSION,
    id: "fixed-1",
    method: "tools/call",
    params: { name: "ask" },
  });
});

test("buildRequest omits params entirely when none is given", () => {
  const req = buildRequest("tools/list", undefined, "fixed-2");
  expect("params" in req).toBe(false);
  expect(req.method).toBe("tools/list");
  expect(req.id).toBe("fixed-2");
});

test("buildRequest generates an id when one is not supplied", () => {
  const req = buildRequest("initialize");
  expect(typeof req.id).toBe("string");
  expect(req.id).not.toBe("");
});

test("buildNotification has no id and omits empty params", () => {
  const note = buildNotification("notifications/initialized");
  expect("id" in note).toBe(false);
  expect("params" in note).toBe(false);
  expect(note.method).toBe("notifications/initialized");
});

test("buildNotification keeps params when supplied", () => {
  const note = buildNotification("notifications/progress", { progressToken: "p1", progress: 1 });
  expect(note.params).toEqual({ progressToken: "p1", progress: 1 });
});

test("nextRequestId is unique and shaped prefix-counter", () => {
  const a = nextRequestId();
  const b = nextRequestId();
  expect(a).not.toBe(b);
  expect(a).toMatch(/^[0-9a-f]{8}-\d+$/);
});

test("isJsonRpcResponse accepts success and failure envelopes", () => {
  expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: {} })).toBe(true);
  expect(
    isJsonRpcResponse({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad" } }),
  ).toBe(true);
  // An error response with a null id (C-3 permits this) is still a response.
  expect(
    isJsonRpcResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "x" } }),
  ).toBe(true);
});

test("isJsonRpcResponse rejects requests, notifications and junk", () => {
  expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, method: "m" })).toBe(false); // request
  expect(isJsonRpcResponse({ jsonrpc: "2.0", method: "m" })).toBe(false); // notification
  expect(isJsonRpcResponse({ jsonrpc: "1.0", id: 1, result: 1 })).toBe(false); // wrong version
  expect(isJsonRpcResponse(null)).toBe(false);
  expect(isJsonRpcResponse("nope")).toBe(false);
  expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, error: { code: "x", message: 1 } })).toBe(
    false,
  );
});

test("isSuccess and isFailure discriminate the envelope", () => {
  const ok = { jsonrpc: "2.0", id: 1, result: { a: 1 } } as const;
  const bad = { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no" } } as const;
  expect(isJsonRpcResponse(ok) && isSuccess(ok)).toBe(true);
  expect(isJsonRpcResponse(bad) && isFailure(bad)).toBe(true);
  expect(isJsonRpcResponse(ok) && isFailure(ok)).toBe(false);
});

test("isJsonRpcNotification detects method-without-id", () => {
  expect(isJsonRpcNotification({ jsonrpc: "2.0", method: "notifications/progress" })).toBe(true);
  expect(isJsonRpcNotification({ jsonrpc: "2.0", id: 1, method: "m" })).toBe(false);
  expect(isJsonRpcNotification({ jsonrpc: "2.0", id: 1, result: 1 })).toBe(false);
});

test("matchResponseById finds the matching envelope in a batch", () => {
  const batch = [
    { jsonrpc: "2.0", method: "notifications/progress", params: {} },
    { jsonrpc: "2.0", id: "a", result: 1 },
    { jsonrpc: "2.0", id: "b", error: { code: -32602, message: "bad" } },
  ];
  expect(matchResponseById(batch, "b")).toEqual({
    jsonrpc: "2.0",
    id: "b",
    error: { code: -32602, message: "bad" },
  });
  expect(matchResponseById(batch, "missing")).toBeUndefined();
});

test("hasErrorCode matches the JSON-RPC error code", () => {
  const err = { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } };
  expect(hasErrorCode(err, -32601)).toBe(true);
  expect(hasErrorCode(err, -32602)).toBe(false);
  expect(hasErrorCode({ jsonrpc: "2.0", id: 1, result: 1 }, -32601)).toBe(false);
});

test("notificationsByMethod collects only matching notifications", () => {
  const msgs = [
    { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
    { jsonrpc: "2.0", id: 1, result: {} },
    { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 2 } },
    { jsonrpc: "2.0", method: "notifications/resources/updated", params: {} },
  ];
  const progress = notificationsByMethod(msgs, "notifications/progress");
  expect(progress).toHaveLength(2);
  expect(progress.map((n) => (n.params as { progress: number }).progress)).toEqual([1, 2]);
});
