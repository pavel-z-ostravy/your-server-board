import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";

import createMockRes from "test-utils/create-mock-res";

const { readConfigDocument, writeConfigDocument } = vi.hoisted(() => ({
  readConfigDocument: vi.fn(),
  writeConfigDocument: vi.fn(),
}));
vi.mock("utils/config/configWriter", () => ({ readConfigDocument, writeConfigDocument }));

const { logger } = vi.hoisted(() => ({ logger: { error: vi.fn() } }));
vi.mock("utils/logger", () => ({ default: () => logger }));

import handler from "pages/api/widgets-catalog/uninstall/index";

const SERVICES_FIXTURE = `---
- Media:
    - Plex:
        href: http://plex.local/
        widget:
          type: plex
          url: http://x
    - Sonarr:
        href: http://sonarr.local/
`;

const WIDGETS_FIXTURE = `---
- resources:
    cpu: true
- datetime:
    text_size: xl
`;

describe("pages/api/widgets-catalog/uninstall", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 405 for non-POST methods", async () => {
    const req = { method: "GET" };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 400 for an unknown category", async () => {
    const req = { method: "POST", body: { category: "bogus" } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  describe("category: service", () => {
    it("removes the widget block and returns the backup filename", async () => {
      readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));
      writeConfigDocument.mockReturnValue("services.yaml.bak.2026-08-23T00-00-00-000Z");

      const req = { method: "POST", body: { category: "service", serviceName: "Plex" } };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true, backupFile: "services.yaml.bak.2026-08-23T00-00-00-000Z" });

      const [, doc] = writeConfigDocument.mock.calls[0];
      const out = doc.toString();
      expect(out).not.toContain("widget:");
      expect(out).toContain("Plex");
      expect(out).toContain("http://plex.local/");
    });

    it("returns 400 when serviceName is missing", async () => {
      const req = { method: "POST", body: { category: "service" } };
      const res = createMockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(readConfigDocument).not.toHaveBeenCalled();
    });

    it("returns 404 when the service doesn't exist", async () => {
      readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));

      const req = { method: "POST", body: { category: "service", serviceName: "DoesNotExist" } };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(writeConfigDocument).not.toHaveBeenCalled();
    });

    it("returns 404 when the service exists but has no widget", async () => {
      readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));

      const req = { method: "POST", body: { category: "service", serviceName: "Sonarr" } };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(writeConfigDocument).not.toHaveBeenCalled();
    });
  });

  describe("category: info", () => {
    it("removes the item at the given index and returns the backup filename", async () => {
      readConfigDocument.mockReturnValue(parseDocument(WIDGETS_FIXTURE));
      writeConfigDocument.mockReturnValue("widgets.yaml.bak.2026-08-23T00-00-00-000Z");

      const req = { method: "POST", body: { category: "info", slug: "resources", index: 0 } };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const [, doc] = writeConfigDocument.mock.calls[0];
      const out = doc.toString();
      expect(out).not.toContain("resources");
      expect(out).toContain("datetime");
    });

    it("returns 400 when slug or index is missing", async () => {
      const req = { method: "POST", body: { category: "info", slug: "resources" } };
      const res = createMockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 when the index is out of range", async () => {
      readConfigDocument.mockReturnValue(parseDocument(WIDGETS_FIXTURE));

      const req = { method: "POST", body: { category: "info", slug: "resources", index: 99 } };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(writeConfigDocument).not.toHaveBeenCalled();
    });

    it("returns 409 when the slug at that index no longer matches (stale client)", async () => {
      readConfigDocument.mockReturnValue(parseDocument(WIDGETS_FIXTURE));

      const req = { method: "POST", body: { category: "info", slug: "datetime", index: 0 } };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(409);
      expect(writeConfigDocument).not.toHaveBeenCalled();
    });
  });

  it("returns 500 and logs when the write throws", async () => {
    readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));
    writeConfigDocument.mockImplementation(() => {
      throw new Error("disk full");
    });

    const req = { method: "POST", body: { category: "service", serviceName: "Plex" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });
});
