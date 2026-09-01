import { readAuthFile, writeAuthFile } from "utils/auth/auth-file";

export function readTotpState() {
  return readAuthFile();
}

export function writeTotpState(state) {
  writeAuthFile({ totp: state.totp });
}

export function clearTotpState() {
  writeAuthFile({ totp: undefined });
}

export function isTotpEnabled() {
  return Boolean(readAuthFile().totp?.secret);
}
