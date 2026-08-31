// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("components/layout/PageBackground", () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock("utils/config/config", () => ({ getSettings: vi.fn(() => ({})) }));
vi.mock("utils/env", () => ({ isAuthEnabled: () => true }));
vi.mock("utils/auth/totp-store", () => ({ isTotpEnabled: vi.fn(() => false) }));
vi.mock("next-auth/next", () => ({ getServerSession: vi.fn() }));
vi.mock("pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));

import SecurityPage from "pages/security";

describe("pages/security", () => {
  it("walks through enabling 2FA", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ secret: "S", otpauthUrl: "otpauth://x", qrDataUrl: "data:image/png;base64,AAA" }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ enabled: true }) });

    render(<SecurityPage initialSettings={{}} twoFactorEnabled={false} />);

    fireEvent.click(screen.getByRole("button", { name: /enable 2fa/i }));
    expect(await screen.findByAltText("2FA QR code")).toHaveAttribute("src", "data:image/png;base64,AAA");

    fireEvent.change(screen.getByLabelText(/authentication code/i), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(screen.getByText(/2fa is on/i)).toBeInTheDocument());
    expect(global.fetch).toHaveBeenLastCalledWith(
      "/api/security/totp/confirm",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows an error on a bad enrollment code", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ secret: "S", otpauthUrl: "otpauth://x", qrDataUrl: "d" }),
      })
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: "Invalid code" }) });

    render(<SecurityPage initialSettings={{}} twoFactorEnabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: /enable 2fa/i }));
    fireEvent.change(await screen.findByLabelText(/authentication code/i), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(await screen.findByText(/invalid code, try again/i)).toBeInTheDocument();
  });

  it("renders the disable path when already enabled", async () => {
    render(<SecurityPage initialSettings={{}} twoFactorEnabled />);
    expect(screen.getByText(/2fa is on/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disable 2fa/i })).toBeInTheDocument();
  });
});
