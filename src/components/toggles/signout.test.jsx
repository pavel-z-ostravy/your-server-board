// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { signOut, useSession } = vi.hoisted(() => ({
  signOut: vi.fn(),
  useSession: vi.fn(),
}));

vi.mock("next-auth/react", () => ({ signOut, useSession }));
vi.mock("next-i18next/pages", () => ({ useTranslation: () => ({ t: (key) => key }) }));

import SignOut from "./signout";

describe("components/toggles/signout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["unauthenticated", "loading"])("renders nothing when session status is %s", (status) => {
    useSession.mockReturnValue({ status });

    const { container } = render(<SignOut />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders and signs out to an absolute URL on the current origin when authenticated", () => {
    useSession.mockReturnValue({ status: "authenticated" });

    const { getByRole } = render(<SignOut />);
    fireEvent.click(getByRole("button"));

    // jsdom's default origin is http://localhost:3000 — the point is that it is
    // absolute and built from window.location, not a bare "/".
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: `${window.location.origin}/` });
    expect(signOut.mock.calls[0][0].callbackUrl).toMatch(/^https?:\/\//);
  });
});
