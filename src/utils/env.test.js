import { afterEach, describe, expect, it } from "vitest";
import { isAuthEnabled } from "utils/env";

const restore = () => delete process.env.HOMEPAGE_AUTH_ENABLED;
afterEach(restore);

describe("isAuthEnabled", () => {
  it.each([
    [undefined, true], ["", true], ["true", true], ["1", true], ["yes", true], ["false", false],
  ])("%s -> %s", (val, expected) => {
    if (val === undefined) restore();
    else process.env.HOMEPAGE_AUTH_ENABLED = val;
    expect(isAuthEnabled()).toBe(expected);
  });
});
