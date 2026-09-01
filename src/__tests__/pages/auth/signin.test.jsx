// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSettingsMock, passwordAuthActiveMock, isTotpEnabledMock, routerState } = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
  passwordAuthActiveMock: vi.fn(),
  isTotpEnabledMock: vi.fn(),
  routerState: { query: {} },
}));

vi.mock("utils/config/config", () => ({
  getSettings: getSettingsMock,
}));

vi.mock("utils/auth/mode", () => ({
  passwordAuthActive: passwordAuthActiveMock,
}));

vi.mock("utils/auth/totp-store", () => ({
  isTotpEnabled: isTotpEnabledMock,
}));

vi.mock("next/router", () => ({
  useRouter: () => ({
    query: routerState.query,
  }),
}));

import { getProviders, signIn } from "next-auth/react";
import SignInPage, { getServerSideProps } from "pages/auth/signin";

const originalLocation = window.location;

function renderPasswordSignIn({ twoFactorEnabled = false } = {}) {
  render(
    <SignInPage
      providers={{ credentials: { id: "credentials", name: "Credentials", type: "credentials" } }}
      settings={{ theme: "dark", color: "slate", title: "Homepage" }}
      twoFactorEnabled={twoFactorEnabled}
    />,
  );
}

async function fillCredentials(username = "admin", password = "secret") {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
}

describe("pages/auth/signin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routerState.query = {};
    passwordAuthActiveMock.mockReturnValue(false);
    isTotpEnabledMock.mockReturnValue(false);
    delete window.location;
    window.location = { assign: vi.fn() };
  });

  afterEach(() => {
    window.location = originalLocation;
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
        twoFactorEnabled: false,
      },
    });
    expect(res.props.settings).not.toHaveProperty("providers");
    expect(res.props.settings).not.toHaveProperty("layout");
  });

  it("getServerSideProps adds twoFactorEnabled", async () => {
    passwordAuthActiveMock.mockReturnValue(true);
    isTotpEnabledMock.mockReturnValue(true);
    getProviders.mockResolvedValueOnce({ credentials: { id: "credentials", type: "credentials" } });
    getSettingsMock.mockReturnValueOnce({ title: "H" });
    const res = await getServerSideProps({});
    expect(res.props.twoFactorEnabled).toBe(true);
  });

  it("getServerSideProps forces twoFactorEnabled false when password auth is inactive", async () => {
    passwordAuthActiveMock.mockReturnValue(false);
    isTotpEnabledMock.mockReturnValue(true);
    getProviders.mockResolvedValueOnce({ credentials: { id: "credentials", type: "credentials" } });
    getSettingsMock.mockReturnValueOnce({ title: "H" });
    const res = await getServerSideProps({});
    expect(res.props.twoFactorEnabled).toBe(false);
    expect(isTotpEnabledMock).not.toHaveBeenCalled();
  });

  it("2FA off: single step, signIn on submit, error on failure", async () => {
    signIn.mockResolvedValue({ ok: false, error: "CredentialsSignin" });
    renderPasswordSignIn({ twoFactorEnabled: false });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in|continue/i }));
    await waitFor(() =>
      expect(signIn).toHaveBeenCalledWith(
        "credentials",
        expect.objectContaining({ redirect: false, username: "admin", password: "admin" }),
      ),
    );
    expect(await screen.findByText(/invalid username or password/i)).toBeInTheDocument();
  });

  it("2FA off: navigates to the callback URL on success", async () => {
    signIn.mockResolvedValue({ ok: true, url: "/" });
    renderPasswordSignIn({ twoFactorEnabled: false });
    await fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: /sign in|continue/i }));

    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith("/"));
  });

  it("2FA off: does not render the authentication code field", async () => {
    renderPasswordSignIn({ twoFactorEnabled: false });
    expect(screen.queryByLabelText(/authentication code/i)).not.toBeInTheDocument();
  });

  it("2FA on: step 1 -> Continue -> code field -> signIn with token", async () => {
    signIn.mockResolvedValue({ ok: true, url: "/" });
    renderPasswordSignIn({ twoFactorEnabled: true });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    fireEvent.change(await screen.findByLabelText(/authentication code/i), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /verify|sign in/i }));
    await waitFor(() =>
      expect(signIn).toHaveBeenCalledWith("credentials", expect.objectContaining({ token: "123456" })),
    );
    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith("/"));
  });

  it("2FA on: Continue does not hit the network", async () => {
    renderPasswordSignIn({ twoFactorEnabled: true });
    await fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByLabelText(/authentication code/i)).toBeInTheDocument();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("2FA on: the code field keeps its one-time-code attributes", async () => {
    renderPasswordSignIn({ twoFactorEnabled: true });
    await fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    const codeInput = await screen.findByLabelText(/authentication code/i);
    expect(codeInput).toHaveAttribute("inputMode", "numeric");
    expect(codeInput).toHaveAttribute("maxLength", "6");
    expect(codeInput).toHaveAttribute("pattern", "\\d{6}");
    expect(codeInput).toHaveAttribute("autoComplete", "one-time-code");
  });

  it("2FA on: a failed code submission shows the combined error", async () => {
    signIn.mockResolvedValue({ ok: false, error: "CredentialsSignin" });
    renderPasswordSignIn({ twoFactorEnabled: true });
    await fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    fireEvent.change(await screen.findByLabelText(/authentication code/i), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: /verify|sign in/i }));

    expect(await screen.findByText(/invalid username, password, or code/i)).toBeInTheDocument();
  });

  it("2FA on: Back returns to step 1", async () => {
    renderPasswordSignIn({ twoFactorEnabled: true });
    await fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await screen.findByLabelText(/authentication code/i);
    fireEvent.click(screen.getByRole("button", { name: /back/i }));

    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    expect(screen.queryByLabelText(/authentication code/i)).not.toBeInTheDocument();
  });

  it.each(["https://evil.example", "//evil.example"])(
    "ignores an off-origin callbackUrl (%s) and navigates to /",
    async (evil) => {
      routerState.query = { callbackUrl: evil };
      signIn.mockResolvedValue({ ok: true, url: "/" });
      renderPasswordSignIn({ twoFactorEnabled: false });
      await fillCredentials();
      fireEvent.click(screen.getByRole("button", { name: /sign in|continue/i }));

      await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith("/"));
      expect(window.location.assign).not.toHaveBeenCalledWith(evil);
    },
  );

  it("keeps a safe relative callbackUrl", async () => {
    routerState.query = { callbackUrl: "/widgets" };
    signIn.mockResolvedValue({ ok: true, url: "/" });
    renderPasswordSignIn({ twoFactorEnabled: false });
    await fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: /sign in|continue/i }));

    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith("/widgets"));
  });

  it("recovers from a thrown signIn without sticking the form", async () => {
    signIn.mockRejectedValue(new Error("network down"));
    renderPasswordSignIn({ twoFactorEnabled: false });
    await fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: /sign in|continue/i }));

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in|continue/i })).not.toBeDisabled();
  });
});
