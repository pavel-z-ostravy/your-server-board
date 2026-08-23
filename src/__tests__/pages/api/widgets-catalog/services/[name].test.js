import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";

import createMockRes from "test-utils/create-mock-res";

const { readConfigDocument } = vi.hoisted(() => ({ readConfigDocument: vi.fn() }));
vi.mock("utils/config/configWriter", () => ({ readConfigDocument }));

const { logger } = vi.hoisted(() => ({ logger: { error: vi.fn() } }));
vi.mock("utils/logger", () => ({ default: () => logger }));

import handler from "pages/api/widgets-catalog/services/[name]";

const SERVICES_FIXTURE = `---
- Media:
    - Plex:
        href: http://plex.local/
        widget:
          type: plex
          url: http://plex.local:32400
          key: mytokenhere
    - Sonarr:
        href: http://sonarr.local/
`;

describe("pages/api/widgets-catalog/services/[name]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 405 for non-GET methods", async () => {
    const req = { method: "POST", query: { name: "Plex" } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 400 when name is missing", async () => {
    const req = { method: "GET", query: {} };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns the existing widget config as a YAML snippet", async () => {
    readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));

    const req = { method: "GET", query: { name: "Plex" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      yamlSnippet: "widget:\n  type: plex\n  url: http://plex.local:32400\n  key: mytokenhere",
    });
  });

  it("returns a null yamlSnippet when the service has no widget configured", async () => {
    readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));

    const req = { method: "GET", query: { name: "Sonarr" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ yamlSnippet: null });
  });

  it("returns a null yamlSnippet when the service doesn't exist", async () => {
    readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));

    const req = { method: "GET", query: { name: "DoesNotExist" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ yamlSnippet: null });
  });

  it("returns 500 and logs when reading fails", async () => {
    readConfigDocument.mockImplementation(() => {
      throw new Error("disk error");
    });

    const req = { method: "GET", query: { name: "Plex" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });
});
