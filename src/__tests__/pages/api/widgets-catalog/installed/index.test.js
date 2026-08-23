import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";

import createMockRes from "test-utils/create-mock-res";

const { readConfigDocument } = vi.hoisted(() => ({ readConfigDocument: vi.fn() }));
vi.mock("utils/config/configWriter", () => ({ readConfigDocument }));

const { logger } = vi.hoisted(() => ({ logger: { error: vi.fn() } }));
vi.mock("utils/logger", () => ({ default: () => logger }));

import handler from "pages/api/widgets-catalog/installed/index";

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
- resources:
    disk: /mnt
- datetime:
    text_size: xl
`;

describe("pages/api/widgets-catalog/installed", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 405 for non-GET methods", async () => {
    const req = { method: "POST" };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns installed service and info widgets, keyed by slug", async () => {
    readConfigDocument.mockImplementation((filename) =>
      filename === "services.yaml" ? parseDocument(SERVICES_FIXTURE) : parseDocument(WIDGETS_FIXTURE),
    );

    const req = { method: "GET" };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      services: { plex: ["Plex"] },
      info: { resources: [0, 1], datetime: [2] },
    });
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
