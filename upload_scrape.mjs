#!/usr/bin/env node

/**
 * free.ai Image Upload Tool Tester
 * For each image tool page:
 *   1. Load the page
 *   2. Upload a test image via DataTransfer
 *   3. Build FormData with all form fields
 *   4. POST to the GPU endpoint via fetch() inside page.evaluate
 *   5. Capture the response
 */

import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "data");
mkdirSync(OUTPUT_DIR, { recursive: true });

const CHROME_BIN = "/usr/bin/chromium-browser";
const TEST_PNG = new Uint8Array([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE,
  0xD4, 0xCB, 0x27, 0x9B, 0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
]);

async function launch() {
  return puppeteer.launch({
    executablePath: CHROME_BIN,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
}

// Get all image tool URLs from /tools/
async function getToolUrls(browser) {
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0");
  await page.goto("https://free.ai/tools/", { waitUntil: "domcontentloaded", timeout: 20000 });

  const tools = await page.evaluate(() => {
    const found = new Map();
    document.querySelectorAll("a[href]").forEach(a => {
      const href = a.getAttribute("href") || "";
      const text = a.textContent?.trim() || "";
      if (!href.includes("/image/") || text.length < 3) return;
      let url = href.startsWith("http") ? href : "https://free.ai" + href;
      url = url.replace(/\/+$/, "");
      if (url === "https://free.ai/image" || url === "https://free.ai/image/") return;
      if (!found.has(url)) found.set(url, text);
    });
    return [...found.entries()].map(([url, name]) => ({ name, url }));
  });

  await page.close();
  return tools;
}

// Get form field details from a page
async function getFormFields(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

  const fields = await page.evaluate((url) => {
    const form = document.querySelector("form");
    if (!form) return { error: "no form" };

    const fileInputs = [];
    form.querySelectorAll('input[type="file"]').forEach(fi => {
      fileInputs.push({ id: fi.id, name: fi.name });
    });

    const selects = [];
    form.querySelectorAll("select").forEach(sel => {
      const options = [];
      sel.querySelectorAll("option").forEach(opt => {
        options.push({ value: opt.value, label: opt.textContent.trim() });
      });
      if (options.length > 0) {
        selects.push({ id: sel.id, name: sel.name, value: sel.value, options });
      }
    });

    const textareas = [];
    form.querySelectorAll("textarea").forEach(ta => {
      if (ta.id && ta.id !== "unknown") {
        textareas.push({ id: ta.id, name: ta.name, value: ta.value, placeholder: ta.placeholder });
      }
    });

    const textInputs = [];
    form.querySelectorAll('input[type="text"], input[type="number"]').forEach(inp => {
      textInputs.push({
        type: inp.type, name: inp.name, id: inp.id,
        value: inp.value, placeholder: inp.placeholder,
      });
    });

    const btn = document.querySelector('button[type="submit"]');

    // Get model select value for FormData
    const modelSel = form.querySelector("select[id*=model], select[name*=model]");

    // Check for negative prompt textarea
    const hasNegativePrompt = document.body.textContent.toLowerCase().includes("negative prompt");

    return {
      url,
      title: document.title.trim(),
      has_file: fileInputs.length > 0,
      file_inputs: fileInputs,
      selects,
      textareas,
      text_inputs: textInputs,
      submit_button: btn?.textContent?.trim().substring(0, 50) || "Submit",
      model_default: modelSel?.value || (selects.find(s => s.id.includes("model"))?.value) || null,
      has_negative_prompt: hasNegativePrompt,
    };
  });

  await page.close();
  return fields;
}

// Upload + submit via fetch, capture the response
async function testTool(browser, tool, formFields, testImgBytes) {
  if (!formFields.has_file) {
    return { ...tool, form: formFields, status: "skipped_no_file_input" };
  }

  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0");

  try {
    await page.goto(tool.url, { waitUntil: "domcontentloaded", timeout: 15000 });

    // Upload file
    const uploadResult = await page.evaluate(async (bytes) => {
      const fi = document.getElementById("file-input");
      if (!fi) return { error: "file input not found" };
      const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
      const file = new File([blob], "test.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      fi.files = dt.files;
      fi.dispatchEvent(new Event("change", { bubbles: true }));
      // Also dispatch on dropzone
      const dz = document.getElementById("drop-zone");
      if (dz) {
        const dt2 = new DataTransfer();
        dt2.items.add(file);
        dz.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt2 }));
      }
      return { success: fi.files.length > 0, fileName: fi.files?.[0]?.name };
    }, testImgBytes);

    if (!uploadResult.success) {
      return { ...tool, form: formFields, status: "upload_failed", error: uploadResult.error };
    }

    // Build and submit FormData via fetch
    const submitResult = await page.evaluate(async (bytes) => {
      const formEl = document.getElementById("tool-form");
      const fi = document.getElementById("file-input");
      if (!fi?.files?.[0]) return { error: "no file in form" };
      const file = fi.files[0];

      // Build FormData like the page does
      const formData = new FormData();
      formData.append("image", file);

      // Get the GPU URL from the page
      const gpuUrl = window.FREE?.inferenceGpuUrl || "https://gpu4.free.ai";

      // Add all selects
      formEl.querySelectorAll("select").forEach(sel => {
        if (sel.value && sel.value !== "0" && sel.value !== "") {
          formData.append(sel.id || sel.name, sel.value);
        }
      });

      // Add textareas with content
      formEl.querySelectorAll("textarea").forEach(ta => {
        if (ta.value) {
          formData.append(ta.id || ta.name, ta.value);
        }
      });

      // Add text/number inputs
      formEl.querySelectorAll('input[type="text"], input[type="number"]').forEach(inp => {
        if (inp.value && inp.name) {
          formData.append(inp.name, inp.value);
        }
      });

      // Get the endpoint from the form action or build it
      // The form action is usually the current page URL
      // But the actual GPU call goes to /v1/image/edit/ on the GPU host
      try {
        const response = await fetch(gpuUrl + "/v1/image/edit/", {
          method: "POST",
          body: formData,
        });

        const body = await response.text();
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = null; }

        return {
          status: response.status,
          bodyLen: body.length,
          bodyPreview: body.substring(0, 3000),
          parsed: parsed,
          gpuUrl: gpuUrl,
        };
      } catch (err) {
        return { error: err.message };
      }
    }, testImgBytes);

    // Check page state after submit
    const pageState = await page.evaluate(() => {
      return {
        resultVisible: !!document.getElementById("tool-result") &&
          !document.getElementById("tool-result").classList.contains("d-none"),
        resultImg: document.getElementById("result-img")?.src?.substring(0, 150),
        error: document.querySelector(".alert-error, .alert-danger")?.textContent?.trim(),
        url: location.href,
      };
    });

    await page.close();

    return {
      ...tool,
      form: formFields,
      upload_result: uploadResult,
      submit_result: submitResult,
      page_state: pageState,
    };

  } catch (err) {
    await page.close().catch(() => {});
    return { ...tool, form: formFields, status: "error", error: err.message };
  }
}

async function main() {
  const browser = await launch();

  try {
    const tools = await getToolUrls(browser);
    console.log(`Found ${tools.length} image tools\n`);

    const results = [];

    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i];
      process.stdout.write(`\r  [${i + 1}/${tools.length}] ${tool.name}... `);

      // Get form fields
      const formFields = await getFormFields(browser, tool.url);

      // Test the tool
      const result = await testTool(browser, tool, formFields, Array.from(TEST_PNG));
      results.push(result);

      // Rate limit
      if (i < tools.length - 1) await new Promise(r => setTimeout(r, 1500));
    }

    // Summary
    console.log("\n\n=== SUMMARY ===");
    const withFile = results.filter(r => r.form?.has_file);
    console.log(`Total: ${results.length}`);
    console.log(`With file inputs: ${withFile.length}`);

    const completed = withFile.filter(r => r.submit_result?.status);
    console.log(`Submitted: ${completed.length}`);

    for (const r of completed) {
      const sr = r.submit_result;
      const info = sr.parsed
        ? JSON.stringify(sr.parsed).substring(0, 100)
        : sr.bodyPreview.substring(0, 100);
      console.log(`  ${r.name}: ${sr.status} ${info}`);
    }

    const failed = withFile.filter(r => r.status === "upload_failed" || r.status === "error");
    for (const r of failed) {
      console.log(`  ${r.name}: ${r.status} ${r.error || r.submit_result?.error || "-"}`);
    }

    const skipped = results.filter(r => !r.form?.has_file);
    console.log(`Skipped (no file): ${skipped.length}`);

    // Save
    const outputPath = join(OUTPUT_DIR, "upload_tests.json");
    writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`\n✓ Saved: ${outputPath}`);

  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
