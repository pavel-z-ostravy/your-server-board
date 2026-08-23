import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({
  copyFileSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const { checkAndCopyConfig } = vi.hoisted(() => ({ checkAndCopyConfig: vi.fn() }));
vi.mock("utils/config/config", () => ({ default: checkAndCopyConfig, CONF_DIR: "/config" }));

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("utils/logger", () => ({ default: () => logger }));

import { readConfigDocument, writeConfigDocument } from "./configWriter";

describe("readConfigDocument", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ensures the config exists, then reads and parses it", () => {
    readFileSync.mockReturnValue("- resources:\n    cpu: true\n");

    const doc = readConfigDocument("widgets.yaml");

    expect(checkAndCopyConfig).toHaveBeenCalledWith("widgets.yaml");
    expect(readFileSync).toHaveBeenCalledWith("/config/widgets.yaml", "utf8");
    expect(doc.toJS()).toEqual([{ resources: { cpu: true } }]);
  });

  it("throws when the file's content isn't valid YAML", () => {
    readFileSync.mockReturnValue("- resources:\n\tcpu: true\n"); // tab indentation is invalid YAML
    expect(() => readConfigDocument("widgets.yaml")).toThrow("not valid YAML");
  });
});

describe("writeConfigDocument", () => {
  beforeEach(() => vi.clearAllMocks());

  it("backs up the existing file, writes the new content, and returns the backup filename", () => {
    existsSync.mockReturnValue(true);
    const doc = { toString: () => "- resources:\n    cpu: true\n" };

    const backupFile = writeConfigDocument("widgets.yaml", doc);

    expect(copyFileSync).toHaveBeenCalledTimes(1);
    const [src, dest] = copyFileSync.mock.calls[0];
    expect(src).toBe("/config/widgets.yaml");
    expect(dest).toMatch(/^\/config\/widgets\.yaml\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);

    expect(writeFileSync).toHaveBeenCalledWith("/config/widgets.yaml", "- resources:\n    cpu: true\n", "utf8");
    expect(backupFile).toMatch(/^widgets\.yaml\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });

  it("skips the backup when no file exists yet", () => {
    existsSync.mockReturnValue(false);
    const doc = { toString: () => "- resources:\n    cpu: true\n" };

    writeConfigDocument("widgets.yaml", doc);

    expect(copyFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("refuses to write when the mutated document fails to re-parse", () => {
    existsSync.mockReturnValue(false);
    const doc = { toString: () => "- resources:\n\tcpu: true\n" }; // tab indentation is invalid YAML

    expect(() => writeConfigDocument("widgets.yaml", doc)).toThrow("failed to re-parse");
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("never creates a backup when the document fails to serialize, even if the file exists", () => {
    existsSync.mockReturnValue(true);
    const doc = {
      toString: () => {
        throw new Error("Unresolved alias (the anchor must be set before the alias): b");
      },
    };

    expect(() => writeConfigDocument("widgets.yaml", doc)).toThrow("Unresolved alias");
    expect(copyFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("never creates a backup when the mutated document fails to re-parse, even if the file exists", () => {
    existsSync.mockReturnValue(true);
    const doc = { toString: () => "- resources:\n\tcpu: true\n" }; // tab indentation is invalid YAML

    expect(() => writeConfigDocument("widgets.yaml", doc)).toThrow("failed to re-parse");
    expect(copyFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("refuses to write when js-yaml fails to load the output, even though the yaml package accepts it", async () => {
    existsSync.mockReturnValue(false);
    const doc = { toString: () => "- resources:\n    cpu: true\n" };

    const jsYaml = (await import("js-yaml")).default;
    const loadSpy = vi.spyOn(jsYaml, "load").mockImplementation(() => {
      throw new Error("js-yaml: simulated divergence from the yaml package");
    });

    try {
      expect(() => writeConfigDocument("widgets.yaml", doc)).toThrow("failed to re-parse");
      expect(copyFileSync).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
    } finally {
      loadSpy.mockRestore();
    }
  });
});
