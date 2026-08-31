// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSettingsMock, routerState } = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
  routerState: { query: {} },
}));

vi.mock("utils/config/config", () => ({
  getSettings: getSettingsMock,
}));

vi.mock("next/router", () => ({
  useRouter: () => ({
    query: routerState.query,
  }),
}));

import { getProviders, signIn } from "next-auth/react";
import SignInPage, { getServerSideProps } from "pages/auth/signin";

const originalLocation = window.location;

function renderPasswordSignIn() {
  render(
    <SignInPage
      providers={{ credentials: { id: "credentials", name: "Credentials", type: "credentials" } }}
      settings={{ theme: "dark", color: "slate", title: "Homepage" }}
    />,
  );
}

async function submitCredentials(username = "admin", password = "secret") {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /continue/i }));
}

describe("pages/auth/signin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routerState.query = {};
    delete window.location;
    window.location = { assign: vi.fn() };
  });

  afterEach(() => {
    window.location = originalLocation;
    delete global.fetch;
  });

  it("renders an error state when no providers are configured", async () => {
    render(
      <SignInPage
        providers={{}}
        settings={{
          theme: "dark",
          color: "slate",
          title: "Homepage",
        }}
      />,
    );

    expect(screen.getByText("Authentication not configured")).toBeInTheDocument();

    await waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      expect(document.documentElement.classList.contains("scheme-dark")).toBe(true);
      expect(document.documentElement.classList.contains("theme-slate")).toBe(true);
    });
  });

  it("renders provider buttons when providers are available", () => {
    render(
      <SignInPage
        providers={{
          oidc: { id: "oidc", name: "OIDC" },
        }}
        settings={{
          theme: "light",
          color: "emerald",
          title: "My Dashboard",
        }}
      />,
    );

    expect(screen.getByText("Sign in")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /login via oidc/i })).toBeInTheDocument();
  });

  it("getServerSideProps returns providers and only public sign-in settings", async () => {
    getProviders.mockResolvedValueOnce({ foo: { id: "foo", name: "Foo" } });
    getSettingsMock.mockReturnValueOnce({
      theme: "dark",
      color: "slate",
      title: "Homepage",
      background: { image: "background.jpg", opacity: 20 },
      backgroundOpacity: 10,
      providers: {
        longhorn: {
          username: "admin",
          password: "secret",
        },
      },
      layout: { Internal: { style: "row" } },
    });

    const res = await getServerSideProps({});

    expect(getProviders).toHaveBeenCalled();
    expect(getSettingsMock).toHaveBeenCalled();
    expect(res).toEqual({
      props: {
        providers: { foo: { id: "foo", name: "Foo" } },
        settings: {
          theme: "dark",
          color: "slate",
          title: "Homepage",
          background: { image: "background.jpg", opacity: 20 },
          backgroundOpacity: 10,
        },
      },
    });
    expect(res.props.settings).not.toHaveProperty("providers");
    expect(res.props.settings).not.toHaveProperty("layout");
  });

  it("signs in directly when 2FA is disabled", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ twoFactorEnabled: false }) });
    signIn.mockResolvedValue({ ok: true, url: "/" });
    renderPasswordSignIn();
    await submitCredentials();

    await waitFor(() =>
      expect(signIn).toHaveBeenCalledWith(
        "credentials",
        expect.objectContaining({ redirect: false, username: "admin", password: "secret" }),
      ),
    );
  });

  it("shows the code step when 2FA is enabled", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ twoFactorEnabled: true }) });
    renderPasswordSignIn();
    await submitCredentials();

    expect(await screen.findByLabelText("Authentication code")).toBeInTheDocument();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("shows an error on wrong credentials", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "Invalid credentials" }) });
    renderPasswordSignIn();
    await submitCredentials("admin", "bad");
    expect(await screen.findByText(/invalid username or password/i)).toBeInTheDocument();
  });

  it("submits the code and surfaces an invalid-code error", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ twoFactorEnabled: true }) });
    signIn.mockResolvedValue({ ok: false, error: "CredentialsSignin" });
    renderPasswordSignIn();
    await submitCredentials();

    const codeInput = await screen.findByLabelText("Authentication code");
    fireEvent.change(codeInput, { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: /verify/i }));
    expect(await screen.findByText(/invalid authentication code/i)).toBeInTheDocument();
  });
});
