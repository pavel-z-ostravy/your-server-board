// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("components/layout/PageBackground", () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock("utils/config/config", () => ({ getSettings: vi.fn(() => ({})) }));
vi.mock("utils/auth/totp-store", () => ({ isTotpEnabled: vi.fn(() => false) }));
vi.mock("utils/auth/mode", () => ({ passwordAuthActive: vi.fn(() => true) }));
vi.mock("utils/auth/credentials-store", () => ({
  managedByEnv: vi.fn(() => false),
  currentUsername: vi.fn(() => "admin"),
}));

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("swr", () => ({ mutate }));

import SecurityPage from "pages/security";

beforeEach(() => {
  mutate.mockClear();
});

async function openCredentialsStep() {
  fireEvent.click(screen.getByRole("button", { name: /change username & password/i }));
  fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: "admin" } });
  fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: "supersecret" } });
  fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: "supersecret" } });
  fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
}

describe("pages/security — 2FA card", () => {
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
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

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
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(await screen.findByText(/invalid code, try again/i)).toBeInTheDocument();
  });

  it("renders the disable path when already enabled", async () => {
    render(<SecurityPage initialSettings={{}} twoFactorEnabled />);
    expect(screen.getByText(/2fa is on/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disable 2fa/i })).toBeInTheDocument();
  });

  it("shows an explanatory state and no controls when password auth is not active", () => {
    render(<SecurityPage initialSettings={{}} twoFactorEnabled={false} passwordAuthEnabled={false} />);
    expect(screen.getByText(/applies to username \+ password login/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enable 2fa/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /disable 2fa/i })).not.toBeInTheDocument();
  });

  it("passes passwordAuthEnabled through getServerSideProps", async () => {
    const { passwordAuthActive } = await import("utils/auth/mode");
    passwordAuthActive.mockReturnValueOnce(false);
    const { getServerSideProps } = await import("pages/security");
    const res = await getServerSideProps();
    expect(res.props.passwordAuthEnabled).toBe(false);
    expect(res.props.twoFactorEnabled).toBe(false);
  });
});

describe("pages/security — Account card + wizard", () => {
  it("adds managedByEnv and currentUsername to the props", async () => {
    const { getServerSideProps } = await import("pages/security");
    const res = await getServerSideProps();
    expect(res.props.managedByEnv).toBe(false);
    expect(res.props.currentUsername).toBe("admin");
  });

  it("shows the signed-in username in the summary", () => {
    render(<SecurityPage initialSettings={{}} twoFactorEnabled={false} currentUsername="admin" />);
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /change username & password/i })).toBeInTheDocument();
  });

  it("gates the Account card when password auth is not active", () => {
    render(
      <SecurityPage
        initialSettings={{}}
        twoFactorEnabled={false}
        passwordAuthEnabled={false}
        currentUsername="admin"
      />,
    );
    expect(screen.getByText(/managed outside this dashboard/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /change username & password/i }),
    ).not.toBeInTheDocument();
  });

  it("explains env-managed credentials and hides the change button", () => {
    render(
      <SecurityPage initialSettings={{}} twoFactorEnabled={false} managedByEnv currentUsername="admin" />,
    );
    expect(screen.getByText(/managed by/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /change username & password/i }),
    ).not.toBeInTheDocument();
  });

  it("blocks the POST when the new passwords do not match", async () => {
    global.fetch = vi.fn();
    render(<SecurityPage initialSettings={{}} twoFactorEnabled={false} currentUsername="admin" />);
    fireEvent.click(screen.getByRole("button", { name: /change username & password/i }));
    fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: "supersecret" } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: "different" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalledWith(
      "/api/security/credentials",
      expect.anything(),
    );
  });

  it("shows the server error when the credentials POST fails", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "Current password is incorrect." }) });
    render(<SecurityPage initialSettings={{}} twoFactorEnabled={false} currentUsername="admin" />);
    await openCredentialsStep();
    expect(await screen.findByText(/current password is incorrect/i)).toBeInTheDocument();
  });

  it("applies a credentials change and advances to 2FA setup when 2FA is off", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ username: "pavel" }) });
    render(<SecurityPage initialSettings={{}} twoFactorEnabled={false} currentUsername="admin" />);
    await openCredentialsStep();

    expect(await screen.findByRole("button", { name: /set up 2fa/i })).toBeInTheDocument();
    expect(mutate).toHaveBeenCalledWith("/api/security/credentials-status");
  });

  it("applies a credentials change and returns to the summary when 2FA is already on", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ username: "pavel" }) });
    render(<SecurityPage initialSettings={{}} twoFactorEnabled currentUsername="admin" />);
    await openCredentialsStep();

    expect(await screen.findByText("pavel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /set up 2fa/i })).not.toBeInTheDocument();
    expect(mutate).toHaveBeenCalledWith("/api/security/credentials-status");
  });

  it("returns to the summary from the 2FA offer via Not now", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ username: "pavel" }) });
    render(<SecurityPage initialSettings={{}} twoFactorEnabled={false} currentUsername="admin" />);
    await openCredentialsStep();

    fireEvent.click(await screen.findByRole("button", { name: /not now/i }));
    expect(await screen.findByText("pavel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /change username & password/i })).toBeInTheDocument();
  });

  it("sets up 2FA from the wizard", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ username: "pavel" }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ secret: "WIZ", qrDataUrl: "data:image/png;base64,ZZZ" }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    render(<SecurityPage initialSettings={{}} twoFactorEnabled={false} currentUsername="admin" />);
    await openCredentialsStep();

    fireEvent.click(await screen.findByRole("button", { name: /set up 2fa/i }));
    fireEvent.change(await screen.findByLabelText(/verification code/i), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    await waitFor(() => expect(screen.getByText(/2fa is on/i)).toBeInTheDocument());
    expect(global.fetch).toHaveBeenLastCalledWith(
      "/api/security/totp/confirm",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
