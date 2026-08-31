import { useState } from "react";

import PageBackground from "components/layout/PageBackground";

import { passwordAuthActive } from "utils/auth/mode";
import { isTotpEnabled } from "utils/auth/totp-store";
import { getSettings } from "utils/config/config";

const CARD_CLASS =
  "rounded-2xl border border-white/60 bg-white/70 p-6 shadow-lg shadow-black/5 dark:border-white/10 dark:bg-slate-900/70";
const INPUT_CLASS =
  "w-full rounded-xl border border-slate-200 bg-white/90 px-4 py-3 text-sm tracking-[0.4em] text-gray-900 shadow-sm outline-none ring-0 transition focus:border-theme-500 focus:ring-2 focus:ring-theme-500/30 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100";
const LABEL_CLASS = "block text-sm font-medium text-gray-700 dark:text-slate-300";
const PRIMARY_BUTTON_CLASS =
  "w-full rounded-xl bg-theme-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-theme-600/20 transition hover:-translate-y-0.5 hover:bg-theme-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-theme-500 disabled:cursor-not-allowed disabled:opacity-60";
const SECONDARY_BUTTON_CLASS =
  "w-full rounded-xl px-4 py-2 text-sm font-medium text-gray-600 transition hover:text-theme-600 dark:text-slate-400 dark:hover:text-theme-300";
const ERROR_CLASS =
  "mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-200";

const CODE_INPUT_PROPS = {
  type: "text",
  inputMode: "numeric",
  autoComplete: "one-time-code",
  maxLength: 6,
  pattern: "\\d{6}",
};

function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export default function SecurityPage({ initialSettings, twoFactorEnabled, passwordAuthEnabled = true }) {
  const [enabled, setEnabled] = useState(Boolean(twoFactorEnabled));
  const [phase, setPhase] = useState("idle");
  const [enrollment, setEnrollment] = useState(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const resetToIdle = () => {
    setPhase("idle");
    setEnrollment(null);
    setCode("");
    setError("");
    setBusy(false);
  };

  const startEnrollment = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await postJson("/api/security/totp/enroll", {});
      if (!res.ok) {
        setError("Could not start enrollment. Please try again.");
        return;
      }
      setEnrollment(await res.json());
      setPhase("enrolling");
      setCode("");
    } catch {
      setError("Could not start enrollment. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const confirmEnrollment = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await postJson("/api/security/totp/confirm", { secret: enrollment.secret, token: code });
      if (res.status === 400) {
        setError("Invalid code, try again.");
        return;
      }
      if (!res.ok) {
        setError("Something went wrong. Please try again.");
        return;
      }
      setEnabled(true);
      resetToIdle();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const confirmDisable = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await postJson("/api/security/totp/disable", { token: code });
      if (res.status === 400) {
        setError("Invalid code, try again.");
        return;
      }
      if (!res.ok) {
        setError("Something went wrong. Please try again.");
        return;
      }
      setEnabled(false);
      resetToIdle();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const codeInput = (
    <div>
      <label htmlFor="security-totp" className={LABEL_CLASS}>
        Authentication code
      </label>
      <input
        id="security-totp"
        {...CODE_INPUT_PROPS}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        className={`mt-1 ${INPUT_CLASS}`}
      />
    </div>
  );

  return (
    <PageBackground initialSettings={initialSettings}>
      <div className="flex flex-col m-4 sm:m-8 mt-16 mb-2">
        <h1 className="text-theme-800 dark:text-theme-300 text-xl font-medium mb-4">Security</h1>
        <div className={CARD_CLASS}>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100">Two-factor authentication</h2>

          <div className="mt-4 space-y-4">
            {!passwordAuthEnabled && (
              <p className="text-sm text-gray-600 dark:text-slate-300">
                Two-factor authentication applies to username + password login. This deployment uses OIDC (or has
                authentication disabled), so there is nothing to configure here.
              </p>
            )}

            {passwordAuthEnabled && !enabled && phase === "idle" && (
              <>
                <p className="text-sm text-gray-600 dark:text-slate-300">
                  Add a time-based one-time code from an authenticator app as a second factor.
                </p>
                <button type="button" disabled={busy} onClick={startEnrollment} className={PRIMARY_BUTTON_CLASS}>
                  Enable 2FA
                </button>
              </>
            )}

            {phase === "enrolling" && enrollment && (
              <>
                <p className="text-sm text-gray-600 dark:text-slate-300">
                  Scan this QR code with your authenticator app, then enter the 6-digit code it shows.
                </p>
                <img src={enrollment.qrDataUrl} alt="2FA QR code" className="h-44 w-44" />
                <p className="text-xs text-gray-600 dark:text-slate-400">
                  Or enter this secret manually:{" "}
                  <code className="select-all break-all rounded bg-slate-100 px-1 py-0.5 font-mono text-gray-900 dark:bg-slate-800 dark:text-slate-100">
                    {enrollment.secret}
                  </code>
                </p>
                {codeInput}
                <button type="button" disabled={busy} onClick={confirmEnrollment} className={PRIMARY_BUTTON_CLASS}>
                  Confirm
                </button>
                <button type="button" disabled={busy} onClick={resetToIdle} className={SECONDARY_BUTTON_CLASS}>
                  Cancel
                </button>
              </>
            )}

            {passwordAuthEnabled && enabled && phase === "idle" && (
              <>
                <p className="text-sm font-medium text-green-700 dark:text-green-300">2FA is on.</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPhase("disabling");
                    setCode("");
                    setError("");
                  }}
                  className={PRIMARY_BUTTON_CLASS}
                >
                  Disable 2FA
                </button>
              </>
            )}

            {phase === "disabling" && (
              <>
                <p className="text-sm text-gray-600 dark:text-slate-300">
                  Enter a current authentication code to turn 2FA off.
                </p>
                {codeInput}
                <button type="button" disabled={busy} onClick={confirmDisable} className={PRIMARY_BUTTON_CLASS}>
                  Confirm disable
                </button>
                <button type="button" disabled={busy} onClick={resetToIdle} className={SECONDARY_BUTTON_CLASS}>
                  Cancel
                </button>
              </>
            )}

            {error && (
              <p role="alert" className={ERROR_CLASS}>
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    </PageBackground>
  );
}

export async function getServerSideProps() {
  const { providers, ...settings } = getSettings();
  const passwordAuthEnabled = passwordAuthActive();
  const twoFactorEnabled = passwordAuthEnabled ? isTotpEnabled() : false;
  return { props: { initialSettings: settings, twoFactorEnabled, passwordAuthEnabled } };
}
