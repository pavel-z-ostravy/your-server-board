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

import handler from "pages/api/widgets-catalog/install/index";

const SERVICES_FIXTURE = `---
- Media:
    - Plex:
        href: http://plex.local/
        description: My Plex server
    - Sonarr:
        href: http://sonarr.local/
`;

const WIDGETS_FIXTURE = `---
- resources:
    cpu: true
`;

const WIDGET_FRAGMENT = "widget:\n  type: plex\n  url: http://plex.host.or.ip:32400\n  key: mytokenhere\n";
const INFO_SNIPPET = "- datetime:\n    text_size: xl\n";

describe("pages/api/widgets-catalog/install", () => {
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

  describe("category: info", () => {
    it("appends the parsed item to widgets.yaml and returns the backup filename", async () => {
      readConfigDocument.mockReturnValue(parseDocument(WIDGETS_FIXTURE));
      writeConfigDocument.mockReturnValue("widgets.yaml.bak.2026-08-23T00-00-00-000Z");

      const req = { method: "POST", body: { category: "info", yamlSnippet: INFO_SNIPPET } };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true, backupFile: "widgets.yaml.bak.2026-08-23T00-00-00-000Z" });
      expect(readConfigDocument).toHaveBeenCalledWith("widgets.yaml");

      const [filename, doc] = writeConfigDocument.mock.calls[0];
      expect(filename).toBe("widgets.yaml");
      expect(doc.toString()).toContain("datetime");
      expect(doc.toString()).toContain("resources");
    });

    it("returns 400 when yamlSnippet is missing", async () => {
      const req = { method: "POST", body: { category: "info" } };
      const res = createMockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(readConfigDocument).not.toHaveBeenCalled();
    });

    it("returns 400 when yamlSnippet is not a single list item", async () => {
      const req = { method: "POST", body: { category: "info", yamlSnippet: "not: a-list-item" } };
      const res = createMockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(400);
    });
  });

  describe("category: service, mode: attach", () => {
    it("attaches the widget to the named service and returns the backup filename", async () => {
      readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));
      writeConfigDocument.mockReturnValue("services.yaml.bak.2026-08-23T00-00-00-000Z");

      const req = {
        method: "POST",
        body: { category: "service", mode: "attach", serviceName: "Plex", yamlSnippet: WIDGET_FRAGMENT },
      };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true, backupFile: "services.yaml.bak.2026-08-23T00-00-00-000Z" });

      const [, doc] = writeConfigDocument.mock.calls[0];
      expect(doc.toString()).toContain("type: plex");
      expect(doc.toString()).toContain("My Plex server");
    });

    it("returns 404 when the service doesn't exist", async () => {
      readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));

      const req = {
        method: "POST",
        body: { category: "service", mode: "attach", serviceName: "DoesNotExist", yamlSnippet: WIDGET_FRAGMENT },
      };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(writeConfigDocument).not.toHaveBeenCalled();
    });

    it("returns 400 for a malformed widget YAML fragment", async () => {
      const req = {
        method: "POST",
        body: { category: "service", mode: "attach", serviceName: "Plex", yamlSnippet: "not-a-widget-key: 1" },
      };
      const res = createMockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(readConfigDocument).not.toHaveBeenCalled();
    });
  });

  describe("category: service, mode: new", () => {
    it("adds a new service into an existing group", async () => {
      readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));
      writeConfigDocument.mockReturnValue("services.yaml.bak.2026-08-23T00-00-00-000Z");

      const req = {
        method: "POST",
        body: {
          category: "service",
          mode: "new",
          serviceName: "Radarr",
          groupName: "Media",
          href: "http://radarr.local/",
          description: "Movies",
          yamlSnippet: WIDGET_FRAGMENT,
        },
      };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const [, doc] = writeConfigDocument.mock.calls[0];
      const out = doc.toString();
      expect(out).toContain("Radarr");
      expect(out).toContain("http://radarr.local/");
      expect(out).toContain("type: plex");
      expect(out).toContain("Plex");
    });

    it("creates a new group when groupName doesn't exist", async () => {
      readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));
      writeConfigDocument.mockReturnValue("services.yaml.bak.2026-08-23T00-00-00-000Z");

      const req = {
        method: "POST",
        body: {
          category: "service",
          mode: "new",
          serviceName: "Transmission",
          groupName: "Downloads",
          href: "http://transmission.local/",
          description: "",
          yamlSnippet: WIDGET_FRAGMENT,
        },
      };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const [, doc] = writeConfigDocument.mock.calls[0];
      const out = doc.toString();
      expect(out).toContain("Downloads");
      expect(out).toContain("Transmission");
    });

    it("returns 409 when the service name already exists anywhere", async () => {
      readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));

      const req = {
        method: "POST",
        body: {
          category: "service",
          mode: "new",
          serviceName: "Sonarr",
          groupName: "Media",
          href: "http://sonarr2.local/",
          description: "",
          yamlSnippet: WIDGET_FRAGMENT,
        },
      };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(409);
      expect(writeConfigDocument).not.toHaveBeenCalled();
    });

    it("returns 400 when required fields are missing", async () => {
      const req = {
        method: "POST",
        body: { category: "service", mode: "new", serviceName: "X", yamlSnippet: WIDGET_FRAGMENT },
      };
      const res = createMockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(400);
    });
  });

  it("returns 500 and logs when the write throws", async () => {
    readConfigDocument.mockReturnValue(parseDocument(WIDGETS_FIXTURE));
    writeConfigDocument.mockImplementation(() => {
      throw new Error("disk full");
    });

    const req = { method: "POST", body: { category: "info", yamlSnippet: INFO_SNIPPET } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });
});
