import { describe, expect, it } from "vitest";
import { hashPassword, verifyHash } from "utils/auth/password-hash";

describe("utils/auth/password-hash", () => {
  it("round-trips", async () => {
    const h = await hashPassword("correct horse");
    expect(h).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyHash("correct horse", h)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const h = await hashPassword("a");
    expect(await verifyHash("b", h)).toBe(false);
  });

  it("returns false (no throw) for junk stored values", async () => {
    for (const junk of ["", "nope", "scrypt$1$1$1$x", "scrypt$16384$8$1$abc", null, undefined]) {
      expect(await verifyHash("a", junk)).toBe(false);
    }
  });
});
