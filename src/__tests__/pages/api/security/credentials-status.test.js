import createMockRes from "test-utils/create-mock-res";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getServerSession, usingDefaultCredentials, managedByEnv, currentUsername } = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  usingDefaultCredentials: vi.fn(() => true),
  managedByEnv: vi.fn(() => false),
  currentUsername: vi.fn(() => "admin"),
}));
vi.mock("next-auth/next", () => ({ getServerSession }));
vi.mock("pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
vi.mock("utils/auth/credentials-store", () => ({ usingDefaultCredentials, managedByEnv, currentUsername }));

import handler from "pages/api/security/credentials-status";

beforeEach(() => {
  vi.clearAllMocks();
  getServerSession.mockResolvedValue({ user: {} });
  usingDefaultCredentials.mockReturnValue(true);
  managedByEnv.mockReturnValue(false);
  currentUsername.mockReturnValue("admin");
});

describe("GET /api/security/credentials-status", () => {
  it("405 for non-GET", async () => {
    const res = createMockRes();
    await handler({ method: "POST" }, res);
    expect(res.statusCode).toBe(405);
  });

  it("401 without a session", async () => {
    getServerSession.mockResolvedValue(null);
    const res = createMockRes();
    await handler({ method: "GET" }, res);
    expect(res.statusCode).toBe(401);
  });

  it("200 with the default-credentials state", async () => {
    const res = createMockRes();
    await handler({ method: "GET" }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ usingDefaultCredentials: true, managedByEnv: false, username: "admin" });
  });

  it("200 once the credentials have been changed", async () => {
    usingDefaultCredentials.mockReturnValue(false);
    currentUsername.mockReturnValue("pavel");
    const res = createMockRes();
    await handler({ method: "GET" }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ usingDefaultCredentials: false, managedByEnv: false, username: "pavel" });
  });

  it("200 when credentials are managed by env vars", async () => {
    usingDefaultCredentials.mockReturnValue(false);
    managedByEnv.mockReturnValue(true);
    currentUsername.mockReturnValue("envadmin");
    const res = createMockRes();
    await handler({ method: "GET" }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ usingDefaultCredentials: false, managedByEnv: true, username: "envadmin" });
  });
});
