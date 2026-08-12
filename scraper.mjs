#!/usr/bin/env node

/**
 * free.ai Image Tools Scraper — Puppeteer Edition
 * Crawls free.ai with a real browser for full JS-rendered content.
 * Usage: node scraper.mjs [tools|details|curls]
 */

import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "data");

const BASE_URL = "https://free.ai";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── Chrome binary ──────────────────────────────────────────────
const CHROME_BIN = "/usr/bin/chromium-browser";

// ── Browser init ──────────────────────────────────────────────
async function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME_BIN,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--single-process",
      "--no-zygote",
    ],
    ignoreDefaultArgs: ["--disable-extensions"],
  });
}

// ── Page fetch helper with Puppeteer ──────────────────────────
async function pageFetch(url, browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setRequestInterception(true);
  // Block non-essential resources for speed
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "font", "media", "stylesheet"].includes(type)) {
      // Allow CSS and JS (needed for rendering)
      if (type === "stylesheet" || type === "script") {
        req.continue();
      } else {
        req.abort();
      }
    } else {
      req.continue();
    }
  });

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  } catch {
    // Page might timeout but content is often loaded
    // Try to get what we have
  }

  const html = await page.content();
  const title = await page.title();
  await page.close();
  return { html, title };
}

// ── 1. Scrape /tools/ with Puppeteer ──────────────────────────
async function scrapeToolsListing(browser) {
  console.log("[1/4] Scraping /tools/ with Puppeteer...");
  const { html } = await pageFetch(`${BASE_URL}/tools/`, browser);
  const tools = [];
  const seen = new Set();

  // Use puppeteer page evaluation for DOM parsing
  const toolsList = await browser.newPage();
  await toolsList.setUserAgent(USER_AGENT);
  await toolsList.goto(`${BASE_URL}/tools/`, { waitUntil: "domcontentloaded", timeout: 30000 });

  const result = await toolsList.evaluate(() => {
    const found = [];
    const seen = new Set();
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      const text = a.textContent?.trim() || "";
      if (!href.includes("/image/") || text.length < 3) return;

      let url = href.startsWith("http") ? href : "https://free.ai" + href;
      url = url.replace(/\/+$/, "");

      if (seen.has(url)) return;
      seen.add(url);

      if (url === "https://free.ai/image" || url === "https://free.ai/image/") return;

      found.push({ name: text, url });
    });
    return found;
  });

  await toolsList.close();
  return result;
}

// ── 2. Scrape /image/ with Puppeteer ──────────────────────────
async function scrapeImagePage(browser) {
  console.log("[2/4] Scraping /image/ with Puppeteer...");
  const { html } = await pageFetch(`${BASE_URL}/image/`, browser);

  const info = await browser.newPage();
  await info.setUserAgent(USER_AGENT);
  await info.goto(`${BASE_URL}/image/`, { waitUntil: "domcontentloaded", timeout: 30000 });

  const result = await info.evaluate(() => {
    // ── Models from pricing table ──
    const models = [];
    document.querySelectorAll("table").forEach((table) => {
      const rows = table.querySelectorAll("tbody tr");
      if (rows.length < 2) return;
      rows.forEach((row) => {
        const cells = row.querySelectorAll("td");
        if (cells.length >= 2) {
          const name = cells[0].textContent.trim();
          const tokens = cells[1].textContent.trim();
          const bestFor = cells.length >= 3 ? cells[2].textContent.trim() : "";
          const cleanTokens = tokens.replace(/[^0-9]/g, "");
          if (name && cleanTokens) {
            models.push({
              model: name,
              tokens_per_image: cleanTokens,
              best_for: bestFor,
            });
          }
        }
      });
    });

    // ── Model dropdown options ──
    const modelSelects = document.querySelectorAll('select[id*="model"], select[name*="model"]');
    const modelOptions = [];
    modelSelects.forEach((sel) => {
      sel.querySelectorAll("option").forEach((opt) => {
        const val = opt.value;
        const label = opt.textContent.trim();
        if (val && label && val.length < 60) {
          modelOptions.push({ value: val, label });
        }
      });
    });

    // ── Aspect ratios ──
    const aspectOptions = [];
    document.querySelectorAll("select").forEach((sel) => {
      sel.querySelectorAll("option").forEach((opt) => {
        if (opt.textContent.match(/^\d+:\d/) || opt.value.match(/^\d+:\d/)) {
          aspectOptions.push(opt.textContent.trim() || opt.value);
        }
      });
    });

    // ── Styles ──
    const styleOptions = [];
    document.querySelectorAll("select").forEach((sel) => {
      sel.querySelectorAll("option").forEach((opt) => {
        const label = opt.textContent.trim().toLowerCase();
        if (
          label.includes("photo") ||
          label.includes("art") ||
          label.includes("anime") ||
          label.includes("3d") ||
          label.includes("sketch") ||
          label.includes("watercolor") ||
          label.includes("oil") ||
          label.includes("pixel")
        ) {
          styleOptions.push(opt.textContent.trim());
        }
      });
    });

    // ── Feature flags from body text ──
    const bodyText = document.body.textContent.toLowerCase();
    const features = [];
    const featureKws = [
      "no watermark", "no sign-up", "free", "commercial use",
      "multiple models", "negative prompt", "style reference",
      "instant download", "generate in chat", "multiple",
    ];
    for (const kw of featureKws) {
      if (bodyText.includes(kw)) features.push(kw);
    }

    // ── Stats ──
    const stats = {};
    const toolMatch = bodyText.match(/(\d[\d,]*)\s*tools?/i);
    const modelMatch = bodyText.match(/(\d[\d,]*)\s*models?/i);
    if (toolMatch) stats.total_tools = toolMatch[0];
    if (modelMatch) stats.total_models = modelMatch[0];

    return { models, model_options: modelOptions, aspect_ratios: [...new Set(aspectOptions)], styles: [...new Set(styleOptions)], features, stats };
  });

  await info.close();
  return result;
}

// ── 3. Scrape /api/ with Puppeteer ────────────────────────────
async function scrapeApiInfo(browser) {
  console.log("[3/4] Scraping /api/ with Puppeteer...");
  const apiPage = await browser.newPage();
  await apiPage.setUserAgent(USER_AGENT);
  await apiPage.goto(`${BASE_URL}/api/`, { waitUntil: "domcontentloaded", timeout: 30000 });

  const result = await apiPage.evaluate(() => {
    // Get all text content to find endpoints
    const bodyText = document.body.textContent;

    const endpoints = [];
    const seen = new Set();

    // Pattern: POST /path or GET /path
    const epPattern = /(POST|GET|PUT|DELETE)\s+\/v1\/[\w\/\-\?]+/gi;
    let m;
    while ((m = epPattern.exec(bodyText)) !== null) {
      const path = m[0].split(" ")[1].replace(/\/+$/, "");
      if (!seen.has(path) && path.length > 5) {
        seen.add(path);
        endpoints.push({ method: m[1], path });
      }
    }

    // Also look for API URLs in curl examples
    const apiPattern = /https?:\/\/api\.free\.ai\/v1\/[\w\/\-]+/gi;
    while ((m = apiPattern.exec(bodyText)) !== null) {
      const path = m[0].replace("https://api.free.ai", "/v1").replace(/\/+$/, "");
      if (!seen.has(path)) {
        seen.add(path);
        endpoints.push({ method: "POST", path });
      }
    }

    const imageEndpoints = endpoints.filter(
      (ep) =>
        ep.path.includes("image") ||
        ep.path.includes("photo") ||
        ep.path.includes("background") ||
        ep.path.includes("upscale") ||
        ep.path.includes("enhance") ||
        ep.path.includes("remove-bg") ||
        ep.path.includes("depth") ||
        ep.path.includes("describe")
    );

    return { endpoints, image_endpoints: imageEndpoints };
  });

  await apiPage.close();
  return result;
}

// ── 4. Scrape individual tool detail pages with Puppeteer ─────
async function scrapeToolDetail(url, browser) {
  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "font", "media"].includes(type)) req.abort();
      else req.continue();
    });

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    } catch {
      // Continue anyway
    }

    const result = await page.evaluate((url) => {
      // ── Form structure ──
      const form = document.querySelector("form");
      if (!form) {
        page.close();
        return { url, error: "no form" };
      }

      const selects = [];
      form.querySelectorAll("select").forEach((sel) => {
        const id = sel.id || "";
        const options = [];
        sel.querySelectorAll("option").forEach((opt) => {
          options.push({
            value: opt.value,
            label: opt.textContent.trim(),
          });
        });
        if (options.length > 0 && id && id !== "(none)") {
          selects.push({ id, options });
        }
      });

      const textareas = [];
      form.querySelectorAll("textarea").forEach((ta) => {
        const id = ta.id || "";
        const placeholder = ta.placeholder || "";
        if (id && id !== "(none)" && !id.includes("feedback")) {
          textareas.push({ id, placeholder });
        }
      });

      const fileInputs = [];
      form.querySelectorAll('input[type="file"]').forEach((fi) => {
        const id = fi.id || "";
        const name = fi.name || "";
        fileInputs.push({ id, name });
      });

      const textInputs = [];
      form.querySelectorAll('input[type="text"], input[type="number"], input[type="range"]').forEach((inp) => {
        textInputs.push({
          type: inp.type,
          name: inp.name || "",
          id: inp.id || "",
          min: inp.min || "",
          max: inp.max || "",
          default: inp.value || "",
        });
      });

      // ── Title ──
      const title = document.title.trim() ||
        document.querySelector("h1")?.textContent?.trim() ||
        "";

      // ── Meta description ──
      const metaDesc =
        document.querySelector('meta[name="description"]')?.content ||
        document.querySelector('meta[property="og:description"]')?.content ||
        "";

      return {
        url,
        title,
        description: metaDesc,
        form: {
          has_file: fileInputs.length > 0,
          file_fields: fileInputs,
          selects,
          textareas,
          text_inputs: textInputs,
          select_count: selects.length,
          textarea_count: textareas.length,
        },
        has_token_info: document.body.textContent.toLowerCase().includes("token"),
        has_model_selector: selects.some((s) => s.id.includes("model")),
        has_negative_prompt: document.body.textContent.toLowerCase().includes("negative"),
        has_seed_input: textInputs.some((i) => i.name.includes("seed")),
      };
    }, url);

    await page.close();
    return result;
  } catch (err) {
    return { url, error: err.message };
  }
}

// ── Generate curl examples from form structure ─────────────────
function generateCurlExample(tool, detail) {
  if (!detail?.form) return null;
  const f = detail.form;

  // Build the base URL
  const curlUrl = tool.url;
  const fields = [];

  // Add file upload if present (use id since free.ai uses id for file fields)
  if (f.has_file && f.file_fields.length > 0) {
    const fi = f.file_fields[0];
    const name = fi.id || fi.name;
    if (name && name !== "unknown" && !name.includes("csrf")) {
      fields.push(`  -F "${name}=@your-image.jpg"`);
    }
    // If first one was unknown, try others
    if (!fields[0] && f.file_fields.length > 1) {
      const fi2 = f.file_fields[1];
      const name2 = fi2.id || fi2.name;
      if (name2 && name2 !== "unknown" && !name2.includes("csrf")) {
        fields.push(`  -F "${name2}=@your-image.jpg"`);
      }
    }
  }

  // Add textarea (prompt)
  for (const ta of f.textareas) {
    const name = ta.id;
    if (name && name !== "unknown" && !name.includes("feedback")) {
      fields.push(`  -F "${name}='your prompt here'"`);
    }
  }

  // Add selects with their default/first option
  for (const sel of f.selects) {
    const name = sel.id;
    if (name && name !== "unknown" && sel.options.length > 0) {
      const firstVal = sel.options[0].value;
      fields.push(`  -F "${name}=${firstVal}"`);
    }
  }

  // Add range/text inputs with defaults — skip unnamed/unknown
  for (const inp of f.text_inputs) {
    if (inp.type === "range" && inp.name && inp.name !== "unknown" && !inp.name.includes("csrf")) {
      fields.push(`  -F "${inp.name}=${inp.default || inp.min}"`);
    }
  }

  if (fields.length === 0) {
    // No form fields — might be a simple POST
    return `curl -X POST ${curlUrl} \\`;
  }

  const curl = [
    `curl -X POST ${curlUrl} \\`,
    ...fields,
  ].join("\n");

  return curl;
}

// ── 5. Upload mode — test file-upload tools with real browser ───
async function scrapeUploadTools(browser, tools) {
  console.log("[5/5] Testing file-upload tools with browser...");

  // Create a tiny test image
  const { writeFileSync, mkdirSync } = await import("fs");
  const { join } = await import("path");
  const tmpDir = join(__dirname, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const testPng = join(tmpDir, "test_input.png");

  // 1x1 red PNG
  const pngHeader = Buffer.from([
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
  writeFileSync(testPng, pngHeader);

  // Filter only tools that have file inputs (from earlier scrape)
  const uploadTools = tools.filter(
    (t) => t.form?.has_file && t.form.file_fields?.length > 0
  );
  console.log(`  Found ${uploadTools.length} file-upload tools to test\n`);

  const uploadResults = [];

  for (let i = 0; i < uploadTools.length; i++) {
    const tool = uploadTools[i];
    console.log(`  [${i + 1}/${uploadTools.length}] ${tool.name}`);

    try {
      const page = await browser.newPage();
      await page.setUserAgent(USER_AGENT);

      // Intercept all XHR/fetch to capture the actual POST
      const capturedRequests = [];
      const capturedResponses = [];

      page.on("request", (req) => {
        if (req.resourceType() === "fetch" || req.resourceType() === "xhr") {
          capturedRequests.push({
            url: req.url(),
            method: req.method(),
            headers: req.headers(),
            postData: req.postData()
              ? (req.postData().length > 2000
                  ? req.postData().substring(0, 2000) + "..."
                  : req.postData())
              : null,
          });
        }
      });

      page.on("response", async (resp) => {
        try {
          const url = resp.url();
          if (url.includes("free.ai")) {
            const body = await resp.text();
            capturedResponses.push({
              url,
              status: resp.status(),
              headers: resp.headers(),
              body: body.substring(0, 3000),
            });
          }
        } catch {}
      });

      // Navigate to the tool page
      await page.goto(tool.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await new Promise((r) => setTimeout(r, 2000));

      // Upload the test image
      const { readFileSync } = await import("fs");
      const buffer = readFileSync(testPng);
      await page.evaluate(
        async (sel, bytes, mime, fname) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const blob = new Blob([new Uint8Array(bytes)], { type: mime });
          const dt = new DataTransfer();
          dt.items.add(new File([blob], fname, { type: mime }));
          el.files = dt.files;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        },
        tool.form.file_fields[0].id || tool.form.file_fields[0].name,
        Array.from(new Uint8Array(buffer)),
        "image/png",
        "test_input.png"
      );

      // Wait for preview / upload handler
      await new Promise((r) => setTimeout(r, 2000));

      // Check if file was accepted
      const fileAccepted = await page.evaluate((fieldId) => {
        const el = document.querySelector(fieldId);
        return {
          hasFiles: el?.files?.length > 0,
          fileName: el?.files?.[0]?.name,
          fileSize: el?.files?.[0]?.size,
        };
      }, tool.form.file_fields[0].id || tool.form.file_fields[0].name);

      console.log(`    File uploaded: ${JSON.stringify(fileAccepted)}`);

      // Submit the form
      const submitBtn = await page.evaluate(() => {
        const btn = document.querySelector('button[type="submit"]');
        if (btn) {
          btn.click();
          return btn.id || btn.className || "submit-btn";
        }
        return null;
      });

      if (!submitBtn) {
        console.log("    ⚠ No submit button found");
        uploadResults.push({
          ...tool,
          upload_status: "no_submit_button",
          ...fileAccepted,
        });
        await page.close();
        continue;
      }

      // Wait for response
      await new Promise((r) => setTimeout(r, 15000));

      // Capture final page state
      const pageTitle = await page.title();
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));

      await page.close();

      // Extract key info from captured requests
      const apiCalls = capturedRequests.filter(
        (r) =>
          r.method === "POST" &&
          (r.url.includes("gpu") || r.url.includes("/v1/"))
      );
      const apiResponses = capturedResponses.filter(
        (r) => r.url.includes("gpu") || r.url.includes("/v1/")
      );

      const result = {
        ...tool,
        upload_status: fileAccepted.hasFiles ? "submitted" : "upload_failed",
        ...fileAccepted,
        submit_button: submitBtn,
        page_title_after: pageTitle,
        api_calls: apiCalls.map((c) => ({
          url: c.url,
          method: c.method,
          has_post_data: !!c.postData,
          content_type: c.headers["content-type"] || c.headers["content-type"],
        })),
        api_responses: apiResponses.map((r) => ({
          url: r.url,
          status: r.status,
          body_preview: r.body.substring(0, 500),
        })),
        form_action: tool.url,
      };

      uploadResults.push(result);

      // Log summary
      if (apiCalls.length > 0) {
        console.log(
          `    API calls: ${apiCalls.map((c) => c.url).join(", ")}`
        );
      }
      if (apiResponses.length > 0) {
        console.log(
          `    Responses: ${apiResponses
            .map((r) => `${r.status} ${r.url.split("/").pop()}`)
            .join(", ")}`
        );
      }
    } catch (err) {
      console.log(`    ✗ Error: ${err.message}`);
      uploadResults.push({
        ...tool,
        upload_status: "error",
        error: err.message,
      });
    }

    // Rate limit between tools
    if (i < uploadTools.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log(`  ✓ Tested ${uploadResults.length} file-upload tools\n`);
  return uploadResults;
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`Output: ${OUTPUT_DIR}\n`);

  const browser = await launchBrowser();

  try {
    // Step 1: Tools listing
    const tools = await scrapeToolsListing(browser);
    console.log(`  Found ${tools.length} image tools\n`);

    // Step 2: Image generator page
    const imageInfo = await scrapeImagePage(browser);
    console.log(`  Models: ${imageInfo.models.length}`);
    console.log(`  Model options: ${imageInfo.model_options.length}`);
    console.log(`  Styles: ${imageInfo.styles.length}\n`);

    // Step 3: API docs
    const apiInfo = await scrapeApiInfo(browser);
    console.log(`  Total endpoints: ${apiInfo.endpoints.length}`);
    console.log(`  Image endpoints: ${apiInfo.image_endpoints.length}\n`);

    // Step 4: Sample detail pages (adds form structure to tools)
    const arg = process.argv[2];
    let sampleCount = 5;
    if (arg === "details") sampleCount = 15;
    if (arg === "curls") sampleCount = 20;

    // Enrich tools with form detail
    console.log(`[4/5] Sampling ${sampleCount} detail pages...`);
    const sampleUrls = tools.slice(0, sampleCount).map((t) => t.url);
    const sampleResults = [];
    for (let i = 0; i < sampleUrls.length; i++) {
      const detail = await scrapeToolDetail(sampleUrls[i], browser);
      if (!detail.error) {
        sampleResults.push(detail);
        console.log(`  [${i + 1}/${sampleUrls.length}] ${detail.title || sampleUrls[i].split("/").pop()}`);
      }
      if (i < sampleUrls.length - 1) {
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    // Merge form details into tools
    for (const t of tools) {
      const detail = sampleResults.find((d) => d.url === t.url);
      if (detail) {
        t.form = detail.form;
        t.title = detail.title;
      }
    }

    // Aggregate tool metadata
    const toolMetadata = [];
    for (const t of tools) {
      const detail = sampleResults.find((d) => d.url === t.url);
      toolMetadata.push({
        name: t.name,
        url: t.url,
        ...(detail || {}),
      });
    }

    // Step 5: Upload tools (only in default mode, not details/curls)
    const uploadResults =
      arg === "details" || arg === "curls"
        ? []
        : await scrapeUploadTools(browser, tools);

    // Merge upload results into tool metadata
    for (const t of toolMetadata) {
      const upload = uploadResults.find((u) => u.url === t.url);
      if (upload) {
        t.upload_status = upload.upload_status;
        t.has_files = upload.hasFiles;
        t.api_calls = upload.api_calls;
        t.api_responses = upload.api_responses;
      }
    }

    // ── Compile results ──
    const results = {
      scraped_at: new Date().toISOString(),
      browser: "puppeteer",
      image_tools: tools,
      image_tool_details: toolMetadata,
      models: imageInfo.models,
      model_options: imageInfo.model_options,
      aspect_ratios: imageInfo.aspect_ratios,
      styles: imageInfo.styles,
      features: imageInfo.features,
      stats: imageInfo.stats,
      api: {
        endpoints: apiInfo.endpoints,
        image_endpoints: apiInfo.image_endpoints,
      },
      upload_tests: uploadResults.map((u) => ({
        name: u.name,
        url: u.url,
        upload_status: u.upload_status,
        hasFiles: u.hasFiles,
        fileName: u.fileName,
        fileSize: u.fileSize,
        submit_button: u.submit_button,
        api_calls: u.api_calls,
        api_responses: u.api_responses,
      })),
    };

    // ── Save JSON ──
    const jsonPath = join(OUTPUT_DIR, "freeai_image_tools.json");
    writeFileSync(jsonPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`\n✓ Saved JSON: ${jsonPath}`);

    // ── Generate curl examples ──
    const curlExamples = toolMetadata
      .filter((t) => t.form && t.form.selects.length > 0 && !t.error)
      .map((t) => {
        const curl = generateCurlExample(t, t);
        return { name: t.name, url: t.url, curl };
      });

    if (curlExamples.length > 0) {
      const curlPath = join(OUTPUT_DIR, "curl_examples.json");
      writeFileSync(curlPath, JSON.stringify(curlExamples, null, 2), "utf-8");
      console.log(`✓ Saved curl examples: ${curlPath}`);
    }

    // ── Save report ──
    const lines = [
      "═══════════════════════════════════════════════════════════",
      "  FREE.AI IMAGE TOOLS — SCRAPER REPORT (Puppeteer)",
      `  Generated: ${results.scraped_at}`,
      "═══════════════════════════════════════════════════════════",
      "",
      `📸 Image Tools Catalogued: ${results.image_tools.length}`,
      `🤖 Image Models: ${results.models.length}`,
      `🔌 API Endpoints: ${results.api.endpoints.length}`,
      `   (Image-specific: ${results.api.image_endpoints.length})`,
      "",
      "── MODELS & TOKEN COSTS ──────────────────────────────",
      ...results.models.map((m) =>
        `  • ${m.model.padEnd(28)} ~${m.tokens_per_image.padStart(6)} tokens/image${m.best_for ? "  (" + m.best_for + ")" : ""}`
      ),
      "",
      "── ALL MODEL OPTIONS (by dropdown) ─────────────────",
      ...new Set(imageInfo.model_options.map((o) => `  ${o.value.padEnd(50)} → ${o.label}`)),
      "",
      `── ASPECT RATIOS: ${results.aspect_ratios.join(", ")}`,
      `── STYLES: ${results.styles.join(", ")}`,
      `── FEATURES: ${results.features.join(", ")}`,
      "",
      "── IMAGE TOOLS (full catalog) ───────────────────────",
      ...results.image_tools.map((t, i) =>
        `  ${String(i + 1).padStart(3)}. ${t.name.padEnd(35)} ${t.url}`
      ),
      "",
      "── CURL EXAMPLES (auto-generated from form fields) ─",
      ...curlExamples.map((c) => {
        return [
          `# ${c.name}`,
          `# ${c.url}`,
          c.curl,
          "",
        ].join("\n");
      }),
      "",
      "═══════════════════════════════════════════════════════════",
    ].join("\n");

    const reportPath = join(OUTPUT_DIR, "report.txt");
    writeFileSync(reportPath, lines, "utf-8");
    console.log(`✓ Saved report: ${reportPath}`);

    console.log(
      `\n✅ Done! ${results.image_tools.length} tools, ${results.models.length} models, ${results.api.endpoints.length} endpoints`
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
