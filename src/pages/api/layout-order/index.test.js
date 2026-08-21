import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getLayoutOrder, writeLayoutOrder, logger } = vi.hoisted(() => ({
  getLayoutOrder: vi.fn(),
  writeLayoutOrder: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock("utils/config/layoutOrder", async () => {
  const actual = await vi.importActual("utils/config/layoutOrder");
  return { ...actual, getLayoutOrder, writeLayoutOrder };
});
vi.mock("utils/logger", () => ({ default: () => logger }));

import handler from "pages/api/layout-order/index";

describe("pages/api/layout-order", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 405 for unsupported methods", async () => {
    const req = { method: "DELETE" };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(getLayoutOrder).not.toHaveBeenCalled();
  });

  it("GET returns the current order", async () => {
    getLayoutOrder.mockReturnValue(["disks", "services", "bookmarks", "layout-groups", "proxmox-vms"]);
    const req = { method: "GET" };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ order: ["disks", "services", "bookmarks", "layout-groups", "proxmox-vms"] });
  });

  it("POST persists a valid order and returns the merged result", async () => {
    writeLayoutOrder.mockReturnValue(["disks", "services", "bookmarks", "layout-groups", "proxmox-vms"]);
    const req = { method: "POST", body: { order: ["disks", "services"] } };
    const res = createMockRes();

    await handler(req, res);

    expect(writeLayoutOrder).toHaveBeenCalledWith(["disks", "services"]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ order: ["disks", "services", "bookmarks", "layout-groups", "proxmox-vms"] });
  });

  it("POST returns 400 for an order containing an unknown id", async () => {
    const req = { method: "POST", body: { order: ["not-a-real-section"] } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(writeLayoutOrder).not.toHaveBeenCalled();
  });

  it("POST returns 400 when the body has no order", async () => {
    const req = { method: "POST", body: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  it("POST returns 500 and logs when persisting throws", async () => {
    writeLayoutOrder.mockImplementation(() => {
      throw new Error("disk full");
    });
    const req = { method: "POST", body: { order: ["disks"] } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });
});
