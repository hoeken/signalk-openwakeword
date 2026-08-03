/**
 * Live end-to-end test against a REAL Signal K server.
 *
 * Unlike test/e2e.mjs (which stubs the API), this drives the actual plugin on a
 * running server: it uploads a real community model, converts a real ONNX one,
 * and checks that wyoming-openwakeword actually loads them. It is what catches
 * deployment-shaped bugs a stubbed test cannot — container path translation,
 * body parsing, bind-mount ownership.
 *
 * Usage:
 *   SK_URL=http://localhost SK_USER=admin SK_PASSWORD=... node test/e2e-live.mjs
 *
 * Requires: the plugin installed and enabled on that server, signalk-container
 * working, and `advanced.customModels` on. The first conversion pulls a ~1 GB
 * image, so allow several minutes; later ones take seconds.
 */

import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.SK_URL ?? "http://localhost";
const USER = process.env.SK_USER ?? "admin";
const PASSWORD = process.env.SK_PASSWORD ?? "admin";
const PLUGIN = "/plugins/signalk-openwakeword";
const shotDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

/** A real model published in both formats, so we can test upload and convert. */
const MODEL_BASE =
  "https://raw.githubusercontent.com/fwartner/home-assistant-wakewords-collection/main/en/andromeda/andromeda";
const TFLITE_NAME = "e2e_andromeda.tflite";
const ONNX_NAME = "e2e_andromeda_src.onnx";
const CONVERTED_NAME = "e2e_andromeda_src.tflite";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`ok: ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function login() {
  const response = await fetch(`${BASE}/signalk/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(
      `login failed (HTTP ${response.status}) — set SK_USER / SK_PASSWORD`,
    );
  }
  const { token } = await response.json();
  if (!token) throw new Error("login returned no token");
  return token;
}

const api = (token) => ({
  async get(route) {
    const r = await fetch(`${BASE}${PLUGIN}${route}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  },
  async post(route, body) {
    const r = await fetch(`${BASE}${PLUGIN}${route}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/octet-stream" } : {}),
      },
      ...(body ? { body } : {}),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  },
  async del(route) {
    const r = await fetch(`${BASE}${PLUGIN}${route}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  },
});

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not fetch ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

const token = await login();
const sk = api(token);
console.log(`Signal K at ${BASE}, authenticated as ${USER}.\n`);

// --- Preconditions ---------------------------------------------------------
const status = await sk.get("/api/status");
check(
  "plugin is running and ready",
  status.body.status === "ready",
  `status=${status.body.status ?? status.status}`,
);

const before = await sk.get("/api/models");
check(
  "model list is served",
  before.status === 200,
  JSON.stringify(before.body).slice(0, 120),
);
check(
  "custom models are enabled",
  before.body.customModelsEnabled === true,
  "turn on advanced.customModels or uploads will never load",
);

// Clean up anything a previous run left behind.
for (const name of [TFLITE_NAME, ONNX_NAME, CONVERTED_NAME]) {
  await sk.del(`/api/models/${encodeURIComponent(name)}`);
}

// --- Upload a real .tflite -------------------------------------------------
const tflite = await download(`${MODEL_BASE}.tflite`);
check(
  "downloaded a real .tflite fixture",
  tflite.subarray(4, 8).toString() === "TFL3",
);

const upload = await sk.post(`/api/models?filename=${TFLITE_NAME}`, tflite);
check(
  "uploading a .tflite succeeds",
  upload.status === 200,
  JSON.stringify(upload.body).slice(0, 200),
);
check(
  "upload is stored whole",
  upload.body.model?.bytes === tflite.length,
  `${upload.body.model?.bytes} vs ${tflite.length}`,
);

// --- Upload + convert a real .onnx ----------------------------------------
const onnx = await download(`${MODEL_BASE}.onnx`);
await sk.post(`/api/models?filename=${ONNX_NAME}`, onnx);
console.log("converting (first run pulls a ~1 GB image; be patient)…");
const started = Date.now();
const converted = await sk.post(
  `/api/models/${encodeURIComponent(ONNX_NAME)}/convert`,
);
const seconds = Math.round((Date.now() - started) / 1000);
check(
  `converting .onnx → .tflite succeeds (${seconds}s)`,
  converted.status === 200,
  JSON.stringify(converted.body).slice(0, 300),
);
// The point of validating numerically: a layout-swapped model scores garbage
// with no error, so anything but a near-zero difference is a failed conversion.
const diff = converted.body.converted?.maxAbsDiff;
check(
  "converted model matches the ONNX original numerically",
  typeof diff === "number" && diff < 1e-4,
  `maxAbsDiff=${diff}`,
);

// --- The converter must not litter the model directory --------------------
const after = await sk.get("/api/models");
const names = (after.body.models ?? []).map((m) => m.filename);
check(
  "conversion leaves no intermediate files behind",
  !names.some((n) => /prepped|float16|schema/.test(n)),
  names.join(", "),
);
check(
  "the .onnx is marked as converted",
  after.body.models?.find((m) => m.filename === ONNX_NAME)?.converted === true,
);

// --- The wake word service actually loads them ----------------------------
// This is the assertion that matters: "installed" is not "usable".
const live = await sk.get("/api/status");
const advertised = (live.body.info?.wake ?? []).flatMap((p) =>
  (p.models ?? []).map((m) => m.name),
);
console.log(`  service advertises: ${advertised.join(", ")}`);
check(
  "the uploaded .tflite is loaded by wyoming-openwakeword",
  advertised.includes(TFLITE_NAME.replace(/\.tflite$/, "")),
  "a restart may be needed for a newly added model",
);

// --- Browser ---------------------------------------------------------------
await fs.mkdir(shotDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1100, height: 900 },
});
// The webapp relies on the session cookie the admin UI would have set.
const loginResponse = await fetch(`${BASE}/signalk/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: USER, password: PASSWORD }),
});
const cookie = loginResponse.headers.get("set-cookie");
if (cookie) {
  const value = cookie.split(";")[0].split("=").slice(1).join("=");
  await context.addCookies([
    {
      name: cookie.split("=")[0],
      value,
      url: BASE,
    },
  ]);
}
const page = await context.newPage();
const apiCalls = [];
page.on("response", (r) => {
  if (r.url().includes("/api/")) apiCalls.push(`${r.status()} ${r.url()}`);
});

try {
  await page.goto(`${BASE}/signalk-openwakeword/`, { waitUntil: "load" });
  await expect(
    page.getByRole("heading", { name: "Custom wake words" }),
  ).toBeVisible({ timeout: 15_000 });
  check("webapp loads from the live server", true);

  await expect(
    page.getByText(TFLITE_NAME.replace(/\.tflite$/, ""), { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  check("webapp lists the model we uploaded over the API", true);
  check(
    "webapp actually called the live API",
    apiCalls.some((c) => c.includes("/api/models")),
    apiCalls.join("; "),
  );

  await expect(page.getByText("in use").first()).toBeVisible();
  check("webapp shows a model as in use", true);

  await page.screenshot({
    path: path.join(shotDir, "live-01-models.png"),
    fullPage: true,
  });
} catch (err) {
  check("browser checks", false, String(err.message).split("\n")[0]);
  await page.screenshot({
    path: path.join(shotDir, "live-failure.png"),
    fullPage: true,
  });
} finally {
  await browser.close();
}

// --- Cleanup ---------------------------------------------------------------
for (const name of [TFLITE_NAME, ONNX_NAME, CONVERTED_NAME]) {
  await sk.del(`/api/models/${encodeURIComponent(name)}`);
}
const final = await sk.get("/api/models");
check(
  "deleting models over the API works",
  !(final.body.models ?? []).some((m) =>
    [TFLITE_NAME, ONNX_NAME, CONVERTED_NAME].includes(m.filename),
  ),
);

console.log(`\n${passed} passed, ${failures.length} failed.`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  - ${f}`);
}
process.exit(failures.length > 0 ? 1 : 0);
