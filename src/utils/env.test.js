import { afterEach, describe, expect, it } from "vitest";
import { isAuthEnabled } from "utils/env";

const restore = () => {
  delete process.env.HOMEPAGE_AUTH_ENABLED;
  delete process.env.HOMEPAGE_AUTH_USERNAME;
  delete process.env.HOMEPAGE_AUTH_PASSWORD;
};
afterEach(restore);

describe("isAuthEnabled", () => {
  it.each([
    [undefined, true], ["", true], ["true", true], ["1", true], ["yes", true], ["false", false], ["FALSE", true], ["0", true], ["off", true],
  ])("%s -> %s", (val, expected) => {
    if (val === undefined) restore();
    else process.env.HOMEPAGE_AUTH_ENABLED = val;
    expect(isAuthEnabled()).toBe(expected);
  });

  it("empty-string env vars behave as unset", async () => {
    process.env.HOMEPAGE_AUTH_USERNAME = "";
    process.env.HOMEPAGE_AUTH_PASSWORD = "";
    const { managedByEnv } = await import("utils/auth/credentials-store");
    expect(managedByEnv()).toBe(false);
  });
});
