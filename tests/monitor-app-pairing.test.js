import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(ROOT, "mobile-app", "App.js");
const appSource = readFileSync(appPath, "utf8");

test("App.js imports pairing-service module", () => {
  assert.match(
    appSource,
    /import\s*\{[\s\S]*?(?:parsePairingPayload|executePairingHandshake)[\s\S]*?\}\s*from\s*["']\.\/pairing-service["']/,
    "App.js must import pairing utilities from ./pairing-service"
  );
});

test("ModalServer wires Cryptographic QR Pairing UI", () => {
  assert.match(
    appSource,
    /devwf:\/\/pair|Pasangkan\s*Perangkat|QR\s*Pairing/i,
    "ModalServer must contain pairing instructions or placeholder"
  );
  assert.match(
    appSource,
    /executePairingHandshake|completePairingAndSaveProfile/i,
    "ModalServer must trigger pairing handshake on confirm"
  );
});

test("handleAddProfile stores authenticated token and deviceId", () => {
  assert.match(
    appSource,
    /profileStore\.addProfile\(\s*\{[\s\S]*?token[\s\S]*?deviceId[\s\S]*?\}\s*\)/,
    "handleAddProfile must pass token and deviceId into profileStore"
  );
});
