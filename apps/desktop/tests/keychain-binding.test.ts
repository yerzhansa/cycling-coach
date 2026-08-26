import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_KEY_BYTES,
  KEYCHAIN_TEAM_IDENTIFIER,
  createKeychainBindingTransport,
  parseKeychainBindingResponse,
} from "../src/main/keychain-binding.js";

describe("keychain binding adapter", () => {
  it("validates the narrow native response shapes", () => {
    const key = randomBytes(KEYCHAIN_KEY_BYTES);
    expect(
      parseKeychainBindingResponse("probe", {
        ok: true,
        teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER,
      }),
    ).toEqual({ ok: true, op: "probe", teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER });
    const read = parseKeychainBindingResponse("read-key", { ok: true, key });
    expect(read).toEqual({
      ok: true,
      op: "read-key",
      key,
    });
    expect(read.ok && read.op === "read-key" ? read.key : undefined).toBe(key);
    const wrongLength = randomBytes(16);
    expect(parseKeychainBindingResponse("create-key", { ok: true, key: wrongLength })).toEqual({
      ok: false,
      code: "unknown",
      creationRollbackPending: true,
    });
    expect(wrongLength).toEqual(Buffer.alloc(16));
    expect(
      parseKeychainBindingResponse("create-key", {
        ok: false,
        code: "unreadable-item",
        creationRollbackPending: false,
      }),
    ).toEqual({
      ok: false,
      code: "unreadable-item",
      creationRollbackPending: false,
    });
    expect(
      parseKeychainBindingResponse("create-key", {
        ok: false,
        code: "unreadable-item",
        creationRollbackPending: true,
      }),
    ).toEqual({
      ok: false,
      code: "unreadable-item",
      creationRollbackPending: true,
    });
    for (const malformed of [
      { ok: false, code: "unreadable-item" },
      { ok: false, code: "unreadable-item", creationRollbackPending: "true" },
    ]) {
      expect(parseKeychainBindingResponse("create-key", malformed)).toEqual({
        ok: false,
        code: "unknown",
        creationRollbackPending: true,
      });
    }
    expect(parseKeychainBindingResponse("retry-created-key-rollback", { ok: true })).toEqual({
      ok: true,
      op: "retry-created-key-rollback",
    });
    expect(parseKeychainBindingResponse("delete-key", { ok: true, deleted: false })).toEqual({
      ok: true,
      op: "delete-key",
      deleted: false,
    });
    expect(parseKeychainBindingResponse("probe", { ok: false, code: "keychain-locked" })).toEqual({
      ok: false,
      code: "keychain-locked",
    });
  });

  it("wipes key buffers discarded from malformed and unrelated responses", () => {
    const failed = randomBytes(KEYCHAIN_KEY_BYTES);
    const unrelated = randomBytes(KEYCHAIN_KEY_BYTES);
    expect(
      parseKeychainBindingResponse("read-key", {
        ok: false,
        code: "unreadable-item",
        key: failed,
      }),
    ).toEqual({ ok: false, code: "unreadable-item" });
    expect(
      parseKeychainBindingResponse("probe", {
        ok: true,
        teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER,
        key: unrelated,
      }),
    ).toEqual({ ok: true, op: "probe", teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER });
    expect(failed).toEqual(Buffer.alloc(KEYCHAIN_KEY_BYTES));
    expect(unrelated).toEqual(Buffer.alloc(KEYCHAIN_KEY_BYTES));
  });

  it("keeps the lifecycle seam asynchronous around an injected native fake", async () => {
    const key = randomBytes(KEYCHAIN_KEY_BYTES);
    const binding = {
      probe: vi.fn(() => ({ ok: true, teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER })),
      readKey: vi.fn(() => ({ ok: true, key })),
      createKey: vi.fn(() => ({ ok: true, key })),
      retryCreatedKeyRollback: vi.fn(() => ({ ok: true })),
      deleteKey: vi.fn(() => ({ ok: true, deleted: true })),
    };
    const loadBinding = vi.fn(() => binding);
    const transport = createKeychainBindingTransport({
      bindingPath: "/synthetic/keychain-binding.node",
      loadBinding,
    });

    await expect(
      transport.send({ op: "probe", service: KEYCHAIN_CREDENTIAL_SERVICE }),
    ).resolves.toEqual({ ok: true, op: "probe", teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER });
    const read = await transport.send({ op: "read-key", service: KEYCHAIN_CREDENTIAL_SERVICE });
    expect(read).toEqual({ ok: true, op: "read-key", key });
    expect(read.ok && read.op === "read-key" ? read.key : undefined).toBe(key);
    await expect(
      transport.send({
        op: "retry-created-key-rollback",
        service: KEYCHAIN_CREDENTIAL_SERVICE,
      }),
    ).resolves.toEqual({ ok: true, op: "retry-created-key-rollback" });
    expect(loadBinding).toHaveBeenCalledOnce();
    expect(binding.readKey).toHaveBeenCalledWith(KEYCHAIN_CREDENTIAL_SERVICE);
    expect(binding.retryCreatedKeyRollback).toHaveBeenCalledWith(KEYCHAIN_CREDENTIAL_SERVICE);
  });

  it("fails closed when native creation throws", async () => {
    const binding = {
      probe: vi.fn(() => ({ ok: true, teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER })),
      readKey: vi.fn(() => ({ ok: false, code: "item-not-found" })),
      createKey: vi.fn(() => {
        throw new Error("synthetic creation failure");
      }),
      retryCreatedKeyRollback: vi.fn(() => ({ ok: true })),
      deleteKey: vi.fn(() => ({ ok: true, deleted: true })),
    };
    const transport = createKeychainBindingTransport({
      bindingPath: "/synthetic/keychain-binding.node",
      loadBinding: () => binding,
    });

    await expect(
      transport.send({ op: "create-key", service: KEYCHAIN_CREDENTIAL_SERVICE }),
    ).resolves.toEqual({
      ok: false,
      code: "unknown",
      creationRollbackPending: true,
    });
  });

  it("maps missing, replaced, and wrong-shape native modules to unknown", async () => {
    for (const loadBinding of [
      () => {
        throw new Error("missing");
      },
      () => ({ probe: () => ({ ok: true }) }),
      () => ({
        probe: () => ({ ok: true, teamIdentifier: "OTHERTEAM" }),
        readKey: () => ({ ok: true, key: Buffer.alloc(KEYCHAIN_KEY_BYTES) }),
        createKey: () => ({ ok: true, key: Buffer.alloc(KEYCHAIN_KEY_BYTES) }),
        retryCreatedKeyRollback: () => ({ ok: true }),
        deleteKey: () => ({ ok: true, deleted: true }),
      }),
    ]) {
      const transport = createKeychainBindingTransport({
        bindingPath: "/synthetic/keychain-binding.node",
        loadBinding,
      });
      await expect(
        transport.send({ op: "probe", service: KEYCHAIN_CREDENTIAL_SERVICE }),
      ).resolves.toEqual({ ok: false, code: "unknown" });
    }
  });
});
