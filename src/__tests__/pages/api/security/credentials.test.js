import { beforeEach, describe, expect, it, vi } from "vitest";
import createMockRes from "test-utils/create-mock-res";

const { getServerSession, verifyPassword, logFailedPasswordSignIn, currentUsername, managedByEnv, writeUser } =
  vi.hoisted(() => ({
    getServerSession: vi.fn(), verifyPassword: vi.fn(), logFailedPasswordSignIn: vi.fn(),
    currentUsername: vi.fn(() => "admin"), managedByEnv: vi.fn(() => false), writeUser: vi.fn(),
  }));
vi.mock("next-auth/next", () => ({ getServerSession }));
vi.mock("pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
vi.mock("utils/auth/credentials", () => ({ verifyPassword, logFailedPasswordSignIn }));
vi.mock("utils/auth/credentials-store", () => ({ currentUsername, managedByEnv, writeUser }));
vi.mock("utils/logger", () => ({ default: () => ({ error: vi.fn() }) }));

import handler from "pages/api/security/credentials";

beforeEach(() => {
  vi.clearAllMocks();
  getServerSession.mockResolvedValue({ user: {} });
  currentUsername.mockReturnValue("admin");
  managedByEnv.mockReturnValue(false);
});

describe("POST /api/security/credentials", () => {
  it("405 for non-POST", async () => {
    const res = createMockRes();
    await handler({ method: "GET" }, res);
    expect(res.statusCode).toBe(405);
  });
  it("401 without a session", async () => {
    getServerSession.mockResolvedValue(null);
    const res = createMockRes();
    await handler({ method: "POST", body: {} }, res);
    expect(res.statusCode).toBe(401);
  });
  it("409 when managed by env", async () => {
    managedByEnv.mockReturnValue(true);
    const res = createMockRes();
    await handler({ method: "POST", body: {} }, res);
    expect(res.statusCode).toBe(409);
  });
  it("400 + log + no write on a wrong current password", async () => {
    verifyPassword.mockResolvedValue(false);
    const res = createMockRes();
    await handler({ method: "POST", body: { currentPassword: "x", username: "pavel", password: "longenough" } }, res);
    expect(res.statusCode).toBe(400);
    expect(logFailedPasswordSignIn).toHaveBeenCalled();
    expect(writeUser).not.toHaveBeenCalled();
  });
  it("400 on a short password / bad username", async () => {
    verifyPassword.mockResolvedValue(true);
    let res = createMockRes();
    await handler({ method: "POST", body: { currentPassword: "ok", username: "pavel", password: "short" } }, res);
    expect(res.statusCode).toBe(400);
    res = createMockRes();
    await handler({ method: "POST", body: { currentPassword: "ok", username: "b a d", password: "longenough" } }, res);
    expect(res.statusCode).toBe(400);
  });
  it("200 trims the username and writes", async () => {
    verifyPassword.mockResolvedValue(true);
    const res = createMockRes();
    await handler({ method: "POST", body: { currentPassword: "ok", username: "  pavel  ", password: "longenough" } }, res);
    expect(writeUser).toHaveBeenCalledWith({ username: "pavel", password: "longenough" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ username: "pavel" });
  });
  it("500 when writeUser throws", async () => {
    verifyPassword.mockResolvedValue(true);
    writeUser.mockRejectedValue(new Error("EACCES"));
    const res = createMockRes();
    await handler({ method: "POST", body: { currentPassword: "ok", username: "pavel", password: "longenough" } }, res);
    expect(res.statusCode).toBe(500);
  });
});
