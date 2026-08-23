import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { parseDocument } from "yaml";

import checkAndCopyConfig, { CONF_DIR } from "utils/config/config";
import createLogger from "utils/logger";

const logger = createLogger("configWriter");

// Reads and parses a config file as a mutable yaml Document. Ensures the
// file exists first (copies the skeleton if missing), same as every other
// config read path in this app.
export function readConfigDocument(filename) {
  checkAndCopyConfig(filename);
  const filePath = join(CONF_DIR, filename);
  const raw = readFileSync(filePath, "utf8");
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new Error(`${filename} is not valid YAML: ${doc.errors[0].message}`);
  }
  return doc;
}

// Creates a timestamped backup copy of filename inside CONF_DIR (if it
// already exists), then writes the mutated document, re-parsing the result
// to confirm it's still valid YAML before treating the write as successful.
// Returns the backup file's basename, or null if no backup was made.
export function writeConfigDocument(filename, doc) {
  const filePath = join(CONF_DIR, filename);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `${filename}.bak.${timestamp}`;
  const backupPath = join(CONF_DIR, backupName);

  let backupFile = null;
  if (existsSync(filePath)) {
    copyFileSync(filePath, backupPath);
    backupFile = backupName;
  }

  const output = doc.toString();

  const revalidation = parseDocument(output);
  if (revalidation.errors.length > 0) {
    throw new Error(`Refusing to write ${filename}: mutated document failed to re-parse`);
  }

  writeFileSync(filePath, output, "utf8");
  logger.info("Wrote %s (backup: %s)", filename, backupFile ?? "none");

  return backupFile;
}
