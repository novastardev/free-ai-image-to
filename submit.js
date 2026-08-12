#!/usr/bin/env node

/**
 * Free.ai All-Tools Submitter
 * Browser-based form automation — no sign-in, no API keys needed.
 *
 * Usage:
 *   # Generate images (text-to-image)
 *   node submit.js generate "prompt" --model sdxl
 *   node submit.js ai-art "prompt"
 *   node submit.js "a cat in space"              # defaults to ai-art, sdxl
 *
 *   # Image editing tools (file-based)
 *   node submit.js remove-bg photo.jpg --out clean.png
 *   node submit.js upscale photo.jpg --scale 2 --out bigger.png
 *   node submit.js enhance photo.jpg --out fixed.png
 *   node submit.js face-swap src.jpg target.jpg --out swapped.png
 *   node submit.js object-remove photo.jpg --out cleaned.png
 *   node submit.js edit photo.jpg "make it sunset" --out edited.png
 *
 *   # Helpers
 *   node submit.js list
 *   node submit.js models
 */

import puppeteer from "puppeteer-core";
import { writeFileSync, readFileSync } from "fs";
import { basename, extname, join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Browser helper ─────────────────────────────────────────────────────

async function launchBrowser() {
  return puppeteer.launch({
    executablePath: "/usr/bin/chromium-browser",
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
}

async function usePage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  return page;
}

// ─── Output URL interceptor ─────────────────────────────────────────────

/**
 * Captures the image output URL that free.ai fetches from
 * api.free.ai/static/outputs/{uuid}.{ext} after generation completes.
 * This works because those GET requests ARE readable by Puppeteer.
 */
function captureOutputUrl(page, maxWait = 90000) {
  return new Promise((resolve) => {
    const done = () => { if (!done.done) { done.done = true; resolve(); } };
    done.done = false;

    let outputUrl = null;

    page.on("response", async (resp) => {
      const url = resp.url();
      if (url.match(/api\.free\.ai\/static\/outputs\//)) {
        outputUrl = url;
        done();
      }
    });

    // Timeout — give up after maxWait
    setTimeout(() => {
      if (outputUrl) done(); // still resolve with what we have
      else resolve(null);
    }, maxWait);
  });
}

/**
 * Wait for output URL AND poll for it.
 * Returns { url, filename } or null on timeout.
 */
async function waitForOutput(page, maxWait = 90000) {
  let waited = 0;
  const tick = 3000;
  console.log(`   ⏳ Waiting for generation...`);

  while (waited < maxWait) {
    const result = await captureOutputUrl(page, tick);
    if (result) {
      // result is the resolved promise value — but we need the actual URL
      // Actually captureOutputUrl returns the URL via the response handler
      // Let me restructure...
    }
    // This approach is getting complicated. Let me use a simpler pattern below.
    break;
  }
  return null;
}

// ─── Download image from URL ────────────────────────────────────────────

async function downloadImage(page, url, outputPath) {
  if (url.startsWith("data:")) {
    const base64Data = url.split(";base64,").pop();
    writeFileSync(outputPath, Buffer.from(base64Data, "base64"));
    return;
  }

  // Use page.evaluate with fetch — works for same-origin or CORS-enabled endpoints
  // For api.free.ai/static/outputs/, the page is on free.ai so cross-origin fetch may fail
  // Use a simple approach: load the image in an <img> tag and grab the blob
  try {
    const buffer = await page.evaluate(async (fetchUrl) => {
      const resp = await fetch(fetchUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const ab = await blob.arrayBuffer();
      return Array.from(new Uint8Array(ab));
    }, url);
    writeFileSync(outputPath, Buffer.from(new Uint8Array(buffer)));
    return;
  } catch {
    // Fallback: use page.screenshot or navigate to URL
    // Actually, the simplest reliable method: load via <img> and extract
    const buffer = await page.evaluate(async (fetchUrl) => {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = async () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const dataUrl = canvas.toDataURL("image/png");
          const base64 = dataUrl.split(";base64,").pop();
          resolve(Array.from(Buffer.from(base64, "base64")));
        };
        img.onerror = () => reject(new Error("Image load failed"));
        img.src = fetchUrl;
      });
    }, url);
    writeFileSync(outputPath, Buffer.from(new Uint8Array(buffer)));
  }
}

// ─── Upload file via DataTransfer ────────────────────────────────────────

async function uploadFile(page, selector, filePath) {
  const buffer = readFileSync(filePath);
  await page.evaluate(
    async (sel, bytes, fname) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(new File([blob], fname, { type: "image/png" }));
      el.files = dt.files;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    selector,
    Array.from(new Uint8Array(buffer)),
    basename(filePath)
  );
  return true;
}

// ─── Base: navigate + wait for form ─────────────────────────────────────

async function navigateTo(page, url, selector, timeout = 15000) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await page.waitForSelector(selector, { timeout: 10000 });
}

// ─── Set form field by CSS selector ─────────────────────────────────────

async function setField(page, selector, value) {
  const el = await page.$(selector);
  if (!el) return;
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.value = val;
    const eventType = el.tagName === "SELECT" ? "change" : "input";
    el.dispatchEvent(new Event(eventType, { bubbles: true }));
  }, selector, value);
}

// ─── Submit via JS click ────────────────────────────────────────────────

async function submitForm(page, selector) {
  await page.evaluate((sel) => {
    const btn = document.querySelector(sel);
    if (btn) {
      if (btn.type === "submit") btn.click();
      else btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  }, selector);
}

// ─── Wait for output URL ────────────────────────────────────────────────

async function waitForOutputUrl(page, maxWait = 90000) {
  let waited = 0;
  const tick = 2000;
  let outputUrl = null;

  const handler = async (resp) => {
    const url = resp.url();
    if (url.match(/api\.free\.ai\/static\/outputs\//)) {
      outputUrl = url;
      outputResolved = true;
    }
  };

  let outputResolved = false;
  page.on("response", handler);

  while (!outputResolved && waited < maxWait) {
    if (outputUrl) break;
    await new Promise((r) => setTimeout(r, tick));
    waited += tick;
    if (waited % 6000 < tick) {
      console.log(`   ...${Math.round(waited / 1000)}s`);
    }
  }

  page.off("response", handler);

  if (outputUrl) {
    const parsed = new URL(outputUrl);
    return { url: outputUrl, fileName: parsed.pathname.split("/").pop() };
  }
  console.log(`\n❌ Timeout waiting for output URL (${Math.round(maxWait / 1000)}s)`);
  return null;
}

// ─── TOOL: text-to-image (ai-art) ───────────────────────────────────────

async function runAiArt(prompt, opts = {}) {
  const {
    model = "sdxl",
    count = 1,
    aspect = "1:1",
    mood = "vibrant",
    negative = "",
    output = "output.png",
  } = opts;

  console.log(`\n🎨 AI Art: "${prompt}"`);
  console.log(`   ${model} | ${count}x | ${aspect} | ${mood}\n`);

  const browser = await launchBrowser();
  const page = await usePage(browser);

  await navigateTo(page, "https://free.ai/image/ai-art", "#aiart-prompt");
  await setField(page, "#aiart-prompt", prompt);
  await setField(page, "#aiart-model", model);
  await setField(page, "#aiart-aspect", aspect);
  await setField(page, "#aiart-mood", mood);
  await setField(page, "#aiart-count", count.toString());
  if (negative) await setField(page, "#aiart-negative", negative);

  console.log("   ⏳ Submitting...");
  await submitForm(page, 'button[type="submit"]');

  const outputData = await waitForOutputUrl(page, 90000);
  if (outputData) {
    // Wait a moment for the image to fully download
    await new Promise((r) => setTimeout(r, 2000));
    await downloadImage(page, outputData.url, output);
    console.log(`   ✅ Saved: ${output}`);
  } else {
    console.log(`\n❌ Failed — no output URL received`);
  }

  await browser.close();
}

// ─── TOOL: background remover ───────────────────────────────────────────

async function runRemoveBg(filePath, opts = {}) {
  const { output = "no_bg.png", model = "rmbg" } = opts;
  console.log(`\n🖼️  Background Remover: ${filePath}`);

  const browser = await launchBrowser();
  const page = await usePage(browser);

  await navigateTo(page, "https://free.ai/image/background-remover", "#file-input");
  await uploadFile(page, "#file-input", filePath);
  await new Promise((r) => setTimeout(r, 2000));

  await setField(page, "#bgrm-model", model);
  await setField(page, "#bgrm-quality", "auto");
  await setField(page, "#bgrm-format", "png");

  console.log("   ⏳ Submitting...");
  await submitForm(page, 'button[type="submit"]');

  const outputData = await waitForOutputUrl(page, 60000);
  if (outputData) {
    await new Promise((r) => setTimeout(r, 1000));
    await downloadImage(page, outputData.url, output);
    console.log(`   ✅ Saved: ${output}`);
  } else {
    console.log(`\n❌ Failed — no output URL received`);
  }

  await browser.close();
}

// ─── TOOL: image upscaler ───────────────────────────────────────────────

async function runUpscale(filePath, opts = {}) {
  const { output = "upscaled.png", model = "realesrgan", scale = "2" } = opts;
  console.log(`\n🔍 Upscaler: ${filePath} (${scale}x)`);

  const browser = await launchBrowser();
  const page = await usePage(browser);

  await navigateTo(page, "https://free.ai/image/upscaler", "#file-input");
  await uploadFile(page, "#file-input", filePath);
  await new Promise((r) => setTimeout(r, 2000));

  await setField(page, "#upscale-model", model);
  await setField(page, "#upscale-scale", scale);

  console.log("   ⏳ Submitting...");
  await submitForm(page, 'button[type="submit"]');

  const outputData = await waitForOutputUrl(page, 60000);
  if (outputData) {
    await new Promise((r) => setTimeout(r, 1000));
    await downloadImage(page, outputData.url, output);
    console.log(`   ✅ Saved: ${output}`);
  } else {
    console.log(`\n❌ Failed — no output URL received`);
  }

  await browser.close();
}

// ─── TOOL: image enhancer ───────────────────────────────────────────────

async function runEnhance(filePath, opts = {}) {
  const { output = "enhanced.png", model = "realesrgan" } = opts;
  console.log(`\n✨ Enhancer: ${filePath}`);

  const browser = await launchBrowser();
  const page = await usePage(browser);

  await navigateTo(page, "https://free.ai/image/enhance", "#file-input");
  await uploadFile(page, "#file-input", filePath);
  await new Promise((r) => setTimeout(r, 2000));

  await setField(page, "#enhance-model", model);

  console.log("   ⏳ Submitting...");
  await submitForm(page, 'button[type="submit"]');

  const outputData = await waitForOutputUrl(page, 60000);
  if (outputData) {
    await new Promise((r) => setTimeout(r, 1000));
    await downloadImage(page, outputData.url, output);
    console.log(`   ✅ Saved: ${output}`);
  } else {
    console.log(`\n❌ Failed — no output URL received`);
  }

  await browser.close();
}

// ─── TOOL: object remover ───────────────────────────────────────────────

async function removeObject(filePath, opts = {}) {
  const { output = "cleaned.png" } = opts;
  console.log(`\n🧹 Object Remover: ${filePath}`);

  const browser = await launchBrowser();
  const page = await usePage(browser);

  await navigateTo(page, "https://free.ai/image/object-remover", "#file-input");
  await uploadFile(page, "#file-input", filePath);
  await new Promise((r) => setTimeout(r, 2000));

  await setField(page, "#removal-mode", "auto");
  await setField(page, "#removal-output", "png");

  console.log("   ⏳ Submitting...");
  await submitForm(page, 'button[type="submit"]');

  const outputData = await waitForOutputUrl(page, 60000);
  if (outputData) {
    await new Promise((r) => setTimeout(r, 1000));
    await downloadImage(page, outputData.url, output);
    console.log(`   ✅ Saved: ${output}`);
  } else {
    console.log(`\n❌ Failed — no output URL received`);
  }

  await browser.close();
}

// ─── TOOL: face swap ────────────────────────────────────────────────────

async function runFaceSwap(srcFile, targetFile, opts = {}) {
  const { output = "swapped.png", model = "inswapper" } = opts;
  console.log(`\n🔄 Face Swap: ${srcFile} → ${targetFile}`);

  const browser = await launchBrowser();
  const page = await usePage(browser);

  await navigateTo(page, "https://free.ai/image/face-swap", "#file-input-source");
  await uploadFile(page, "#file-input-source", srcFile);
  await new Promise((r) => setTimeout(r, 2000));
  await uploadFile(page, "#file-input-target", targetFile);
  await new Promise((r) => setTimeout(r, 2000));

  await setField(page, "#fswap-model", model);

  console.log("   ⏳ Submitting...");
  await submitForm(page, 'button[type="submit"]');

  const outputData = await waitForOutputUrl(page, 60000);
  if (outputData) {
    await new Promise((r) => setTimeout(r, 1000));
    await downloadImage(page, outputData.url, output);
    console.log(`   ✅ Saved: ${output}`);
  } else {
    console.log(`\n❌ Failed — no output URL received`);
  }

  await browser.close();
}

// ─── TOOL: image editor ─────────────────────────────────────────────────

async function runEdit(filePath, prompt, opts = {}) {
  const { output = "edited.png", removeBg = false, swapFace = null } = opts;
  console.log(`\n✏️  Image Editor: ${filePath}`);

  if (removeBg) {
    const browser = await launchBrowser();
    browser.close();
    return runRemoveBg(filePath, { output });
  }
  if (swapFace) {
    const browser = await launchBrowser();
    browser.close();
    return runFaceSwap(filePath, swapFace, { output });
  }

  const browser = await launchBrowser();
  const page = await usePage(browser);

  await navigateTo(page, "https://free.ai/image/edit", "#file-input");
  await uploadFile(page, "#file-input", filePath);
  await new Promise((r) => setTimeout(r, 2000));

  await setField(page, "#edit-prompt", prompt);

  console.log("   ⏳ Submitting...");
  await submitForm(page, 'button[type="submit"]');

  const outputData = await waitForOutputUrl(page, 60000);
  if (outputData) {
    await new Promise((r) => setTimeout(r, 1000));
    await downloadImage(page, outputData.url, output);
    console.log(`   ✅ Saved: ${output}`);
  } else {
    console.log(`\n❌ Failed — no output URL received`);
  }

  await browser.close();
}

// ─── Models list ────────────────────────────────────────────────────────

function listModels() {
  console.log("\n📋 Available Models:\n");
  console.log("  sdxl              — Stable Diffusion XL (fast, free pool)");
  console.log("  flux2-klein       — FLUX.2 Klein (high quality, detailed)");
  console.log("  qwen7b            — Qwen 2.5 7B (fast, lightweight)");
  console.log("\nNote: Premium models (Gemini, GPT-5) require sign-up.");
  console.log();
}

// ─── Tools list ─────────────────────────────────────────────────────────

function listTools() {
  console.log("\n📋 Free.ai Tools (no sign-in needed):\n");
  console.log("  TEXT-TO-IMAGE:");
  console.log("    ai-art, generate  — Text prompt → image");
  console.log("\n  IMAGE-TO-IMAGE (file upload):");
  console.log("    remove-bg, bg      — Remove background");
  console.log("    upscale            — Upscale resolution");
  console.log("    enhance            — Sharpen/enhance");
  console.log("    object-remove      — Remove objects");
  console.log("    face-swap          — Swap faces");
  console.log("    edit               — General image edit");
  console.log();
}

// ─── CLI parser ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

const ALIASES = {
  "remove-bg": "remove-bg",
  "remove_bg": "remove-bg",
  "bg": "remove-bg",
  "background-remover": "remove-bg",
  "upscale": "upscale",
  "upscaler": "upscale",
  "enhance": "enhance",
  "image-enhance": "enhance",
  "object-remove": "object-remove",
  "object-remove-bg": "object-remove",
  "object-remover": "object-remove",
  "face-swap": "face-swap",
  "face_swap": "face-swap",
  "fs": "face-swap",
  "edit": "edit",
  "image-edit": "edit",
  "ai-art": "generate",
  "generate": "generate",
  "gen": "generate",
  "list": "list",
  "models": "models",
  "-h": "help",
  "--help": "help",
};

if (args.length === 0) {
  console.log(`
Free.ai All-Tools Submitter (no sign-in needed)

Usage:
  node submit.js generate "prompt" [--model MODEL] [--aspect R] [--count N] [--output FILE]
  node submit.js ai-art "prompt"
  node submit.js remove-bg photo.jpg [--output FILE]
  node submit.js upscale photo.jpg [--scale 2] [--output FILE]
  node submit.js enhance photo.jpg [--output FILE]
  node submit.js object-remove photo.jpg [--output FILE]
  node submit.js face-swap src.jpg target.jpg [--output FILE]
  node submit.js edit photo.jpg "prompt" [--output FILE]
  node submit.js list
  node submit.js models

Options:
  --model MODEL     sdxl | flux2-klein | qwen7b
  --aspect R        1:1 | 16:9 | 9:16 | 4:3 | 3:4 | 21:9
  --count N         1 or 4 (text-to-image only)
  --scale N         2 or 4 (upscaler only)
  --output FILE     output filename

Examples:
  node submit.js "a cyberpunk cat" --model flux2-klein
  node submit.js remove-bg photo.jpg --out clean.png
  node submit.js face-swap me.jpg celebrity.jpg --out swapped.png
  node submit.js upscale photo.jpg --scale 2
`);
  process.exit(0);
}

// Resolve alias
let command = args[0].toLowerCase().replace(/\s/g, "-");
command = ALIASES[command] || command;

// Parse remaining args
const opts = { output: "output.png" };
const positional = [];

for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "--model") opts.model = args[++i];
  else if (a === "--output" || a === "--out") opts.output = args[++i];
  else if (a === "--aspect" || a === "--ar") opts.aspect = args[++i];
  else if (a === "--count" || a === "--num") opts.count = parseInt(args[++i]);
  else if (a === "--scale" || a === "--sx") opts.scale = args[++i];
  else if (a === "--negative") opts.negative = args[++i];
  else if (a === "--mood") opts.mood = args[++i];
  else if (!a.startsWith("--")) positional.push(a);
}

// Dispatch
switch (command) {
  case "generate":
  case "ai-art": {
    const prompt = positional[0];
    if (!prompt) {
      console.log("❌ Missing prompt. Usage: node submit.js generate \"prompt\" [--model MODEL]");
      process.exit(1);
    }
    await runAiArt(prompt, opts);
    break;
  }
  case "remove-bg": {
    if (!positional[0]) {
      console.log("❌ Missing input file. Usage: node submit.js remove-bg photo.jpg [--output FILE]");
      process.exit(1);
    }
    await runRemoveBg(positional[0], opts);
    break;
  }
  case "upscale": {
    if (!positional[0]) {
      console.log("❌ Missing input file. Usage: node submit.js upscale photo.jpg [--output FILE]");
      process.exit(1);
    }
    await runUpscale(positional[0], opts);
    break;
  }
  case "enhance": {
    if (!positional[0]) {
      console.log("❌ Missing input file. Usage: node submit.js enhance photo.jpg [--output FILE]");
      process.exit(1);
    }
    await runEnhance(positional[0], opts);
    break;
  }
  case "object-remove": {
    if (!positional[0]) {
      console.log("❌ Missing input file. Usage: node submit.js object-remove photo.jpg [--output FILE]");
      process.exit(1);
    }
    await removeObject(positional[0], opts);
    break;
  }
  case "face-swap": {
    if (positional.length < 2) {
      console.log("❌ Missing files. Usage: node submit.js face-swap src.jpg target.jpg [--output FILE]");
      process.exit(1);
    }
    await runFaceSwap(positional[0], positional[1], opts);
    break;
  }
  case "edit": {
    if (positional.length < 1) {
      console.log("❌ Missing input file. Usage: node submit.js edit photo.jpg \"prompt\" [--output FILE]");
      process.exit(1);
    }
    const prompt = positional[1] || "edit this image";
    await runEdit(positional[0], prompt, opts);
    break;
  }
  case "list": listTools(); break;
  case "models": listModels(); break;
  case "help": console.log("Run without arguments or with --help for usage info."); break;
  default:
    console.log(`❌ Unknown command: ${command}`);
    console.log("Run without arguments for usage.");
    process.exit(1);
}
