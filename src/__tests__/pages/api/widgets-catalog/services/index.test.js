import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";

import createMockRes from "test-utils/create-mock-res";

const { readConfigDocument } = vi.hoisted(() => ({ readConfigDocument: vi.fn() }));
vi.mock("utils/config/configWriter", () => ({ readConfigDocument }));

const { logger } = vi.hoisted(() => ({ logger: { error: vi.fn() } }));
vi.mock("utils/logger", () => ({ default: () => logger }));

import handler from "pages/api/widgets-catalog/services/index";

const SERVICES_FIXTURE = `---
- Media:
    - Plex:
        href: http://plex.local/
    - Sonarr:
        href: http://sonarr.local/
- Downloads:
    - Transmission:
        href: http://transmission.local/
`;

describe("pages/api/widgets-catalog/services", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 405 for non-GET methods", async () => {
    const req = { method: "POST" };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns the groups and service names from services.yaml", async () => {
    readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));

    const req = { method: "GET" };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      groups: ["Media", "Downloads"],
      services: ["Plex", "Sonarr", "Transmission"],
    });
    expect(readConfigDocument).toHaveBeenCalledWith("services.yaml");
  });

  it("returns 500 and logs when reading fails", async () => {
    readConfigDocument.mockImplementation(() => {
      throw new Error("disk error");
    });

    const req = { method: "GET" };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });
});
