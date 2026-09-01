// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { useSession, useSWR } = vi.hoisted(() => ({ useSession: vi.fn(), useSWR: vi.fn() }));
vi.mock("next-auth/react", () => ({ useSession }));
vi.mock("swr", () => ({ default: useSWR }));

import CredentialsWarning from "components/layout/CredentialsWarning";

describe("CredentialsWarning", () => {
  it("nothing + no SWR key when unauthenticated", () => {
    useSession.mockReturnValue({ status: "unauthenticated" });
    useSWR.mockReturnValue({ data: undefined });
    const { container } = render(<CredentialsWarning />);
    expect(container).toBeEmptyDOMElement();
    expect(useSWR).toHaveBeenCalledWith(null);
  });

  it("nothing when not using default credentials", () => {
    useSession.mockReturnValue({ status: "authenticated" });
    useSWR.mockReturnValue({ data: { usingDefaultCredentials: false } });
    const { container } = render(<CredentialsWarning />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the alert + link when default", () => {
    useSession.mockReturnValue({ status: "authenticated" });
    useSWR.mockReturnValue({ data: { usingDefaultCredentials: true } });
    render(<CredentialsWarning />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /change them now/i })).toHaveAttribute("href", "/security");
  });
});
