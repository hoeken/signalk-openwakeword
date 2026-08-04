/**
 * Browser check for the Custom wake words webapp.
 *
 * Serves the BUILT artifact from public/ (so this tests what actually ships)
 * against a stub of the plugin API, and asserts three things per check: a DOM
 * assertion, an observed network request, and a screenshot. Run it with:
 *
 *   npm run build && node test/e2e.mjs
 *
 * Screenshots land in test/screenshots/.
 */

import { chromium, expect } from "@playwright/test";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");
const shotDir = path.join(here, "screenshots");

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

/** Models the stub reports; mutated by the upload/delete handlers. */
let models = [
  {
    filename: "hey_seabird.tflite",
    id: "hey_seabird",
    format: "tflite",
    bytes: 204_800,
    modifiedAt: new Date(0).toISOString(),
    live: true,
    selected: true,
  },
  // An .onnx that has NOT been converted — the case that used to fail silently.
  {
    filename: "hey_boat.onnx",
    id: "hey_boat",
    format: "onnx",
    bytes: 1_100_000,
    modifiedAt: new Date(0).toISOString(),
    converted: false,
    live: false,
    selected: false,
  },
];

const requests = [];

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = url.pathname;
    requests.push(route);

    if (route === "/plugins/signalk-openwakeword/api/models") {
      if (req.method === "POST") {
        const filename = url.searchParams.get("filename");
        models = [
          ...models,
          {
            filename,
            id: filename.replace(/\.(tflite|onnx)$/, ""),
            format: filename.endsWith(".onnx") ? "onnx" : "tflite",
            bytes: 1024,
            modifiedAt: new Date(0).toISOString(),
            live: false,
            selected: false,
          },
        ];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: models.at(-1), converted: null }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          customModelsEnabled: true,
          // Keep consistent with the fixtures' `selected` flags below.
          wakeWords: ["hey_seabird"],
          models,
        }),
      );
      return;
    }

    if (route.endsWith("/convert")) {
      const name = decodeURIComponent(route.split("/").at(-2));
      models = models.map((m) =>
        m.filename === name ? { ...m, converted: true } : m,
      );
      models = [
        ...models,
        {
          filename: name.replace(/\.onnx$/, ".tflite"),
          id: name.replace(/\.onnx$/, ""),
          format: "tflite",
          bytes: 204_800,
          modifiedAt: new Date(0).toISOString(),
          live: false,
          selected: false,
        },
      ];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          converted: {
            filename: name.replace(/\.onnx$/, ".tflite"),
            maxAbsDiff: 0,
          },
        }),
      );
      return;
    }

    if (route === "/plugins/signalk-openwakeword/api/train/config") {
      const phrase = url.searchParams.get("phrase") ?? "";
      const slug = phrase
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "_");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          phrase,
          slug,
          modelId: slug,
          notebookUrl: "https://colab.research.google.com/example",
          advice: [
            {
              level: "ok",
              message: `"${phrase}" looks like a good wake word.`,
            },
          ],
          config: `target_phrase: ["${phrase}"]\nmodel_name: "${slug}"`,
          steps: ["one", "two"],
        }),
      );
      return;
    }

    // Static files from the built webapp.
    const file = route === "/" ? "/index.html" : route;
    try {
      const body = await fs.readFile(path.join(publicDir, file));
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

/** Readiness gate: "listening" is not "serving". */
async function waitForServer(base) {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(base)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never answered at ${base}`);
}

const { server, port } = await serve();
const base = `http://127.0.0.1:${port}/`;
await waitForServer(base);
await fs.mkdir(shotDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.on("pageerror", (err) => {
  throw new Error(`uncaught page error: ${err.message}`);
});

let failed = false;
try {
  await page.goto(base, { waitUntil: "load" });

  // 1. The list renders, and shows the wake word id rather than the filename.
  await expect(
    page.getByRole("heading", { name: "Custom wake words" }),
  ).toBeVisible();
  await expect(page.getByText("hey_seabird", { exact: true })).toBeVisible();
  await expect(
    page.locator("td .status", { hasText: "listening" }),
  ).toBeVisible();
  if (!requests.some((r) => r.endsWith("/api/models"))) {
    throw new Error("expected the page to fetch /api/models");
  }
  console.log("ok: model list renders from the API");

  // 2. The unconverted .onnx is called out rather than failing silently.
  await expect(
    page.getByText("needs converting", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("One model needs converting.")).toBeVisible();
  await page.screenshot({
    path: path.join(shotDir, "01-models.png"),
    fullPage: true,
  });
  console.log("ok: unconverted .onnx is flagged");

  // 3. Converting it updates the row.
  await page.getByRole("button", { name: "Convert" }).click();
  await expect(page.getByText(/Converted to hey_boat\.tflite/)).toBeVisible();
  if (!requests.some((r) => r.endsWith("/convert"))) {
    throw new Error("expected a /convert request");
  }
  await page.screenshot({
    path: path.join(shotDir, "02-converted.png"),
    fullPage: true,
  });
  console.log("ok: conversion updates the list");

  // 4. The training wizard runs through phrase advice to the notebook link.
  await page.getByRole("button", { name: "Create a wake word" }).click();
  await expect(
    page.getByRole("dialog", { name: "Create a new wake word" }),
  ).toBeVisible();
  await page.getByLabel("What should the boat answer to?").fill("hey seabird");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText(/looks like a good wake word/)).toBeVisible();
  // The honesty check: the wizard must say training does not run on the server.
  await expect(
    page.getByText(/cannot run on this Signal K server/i),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /training notebook/i }),
  ).toBeVisible();
  if (!requests.some((r) => r.includes("/api/train/config"))) {
    throw new Error("expected a /api/train/config request");
  }
  await page.screenshot({
    path: path.join(shotDir, "03-wizard.png"),
    fullPage: true,
  });
  console.log("ok: training wizard reaches the notebook step");

  console.log("\nAll browser checks passed.");
} catch (err) {
  failed = true;
  await page.screenshot({
    path: path.join(shotDir, "failure.png"),
    fullPage: true,
  });
  console.error(`\nFAILED: ${err.message}`);
} finally {
  await browser.close();
  server.close();
}

process.exit(failed ? 1 : 0);
