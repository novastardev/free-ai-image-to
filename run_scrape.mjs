#!/usr/bin/env node
/**
 * free.ai — test all image upload tools
 * Each tool: load page → upload test PNG → POST to GPU endpoint → record response
 */
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "fs";

const PNG = new Uint8Array([
  0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,
  0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,
  0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,
  0x08,0x02,0x00,0x00,0x00,0x90,0x77,0x53,
  0xDE,0x00,0x00,0x00,0x0C,0x49,0x44,0x41,
  0x54,0x08,0xD7,0x63,0xF8,0xCF,0xC0,0x00,
  0x00,0x00,0x03,0x00,0x01,0x00,0x05,0xFE,
  0xD4,0xCB,0x27,0x9B,0x00,0x00,0x00,0x00,
  0x49,0x45,0x4E,0x44,0xAE,0x42,0x60,0x82,
]);

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "new",
  args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu"],
});

// 1. Get all image tool URLs
const pg0 = await browser.newPage();
await pg0.setUserAgent("Mozilla/5.0");
await pg0.goto("https://free.ai/tools/", { waitUntil:"domcontentloaded", timeout:15000 });
const tools = await pg0.evaluate(() => {
  const m = new Map();
  for (const a of document.querySelectorAll("a[href]")) {
    const h = a.getAttribute("href") || "";
    const t = a.textContent?.trim() || "";
    if (!h.includes("/image/") || t.length < 3) continue;
    let u = h.startsWith("http") ? h : "https://free.ai" + h;
    u = u.replace(/\/+$/, "");
    if (u.endsWith("/image") || u.endsWith("/image/")) continue;
    if (!m.has(u)) m.set(u, t);
  }
  return [...m.entries()].map(([u,n])=>({name:n,url:u}));
});
await pg0.close();
console.log(`Tools: ${tools.length}\n`);

const results = [];

for (let i = 0; i < tools.length; i++) {
  const tool = tools[i];
  process.stdout.write(`[${i+1}/${tools.length}] ${tool.name}... `);

  const pg = await browser.newPage();
  await pg.setUserAgent("Mozilla/5.0");

  const out = { name: tool.name, url: tool.url };

  try {
    // 2. Load the page
    await pg.goto(tool.url, { waitUntil:"domcontentloaded", timeout:10000 });

    // 3. Get form structure
    const formInfo = await pg.evaluate(() => {
      const f = document.querySelector("form");
      if (!f) return { error:"no form" };
      const fi = document.getElementById("file-input");
      const sel = [];
      f.querySelectorAll("select").forEach(s => {
        const opts = [];
        s.querySelectorAll("option").forEach(o => opts.push(o.value));
        sel.push({ id:s.id, name:s.name, value:s.value, opts });
      });
      const ta = [];
      f.querySelectorAll("textarea").forEach(t => {
        if (t.id && t.id !== "unknown") ta.push({ id:t.id, value:t.value });
      });
      return { has_file: !!fi, file_id: fi?.id, selects: sel, textareas: ta };
    });

    if (formInfo.error === "no form") {
      out.status = "no_form";
      results.push(out);
      await pg.close();
      continue;
    }

    out.form = formInfo;

    if (formInfo.has_file) {
      // 4. Upload test image
      const uploaded = await pg.evaluate(async (bytes) => {
        const fi = document.getElementById("file-input");
        if (!fi) return { ok: false };
        const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
        const file = new File([blob], "test.png", { type: "image/png" });
        const dt = new DataTransfer();
        dt.items.add(file);
        fi.files = dt.files;
        fi.dispatchEvent(new Event("change", { bubbles: true }));
        const dz = document.getElementById("drop-zone");
        if (dz) {
          const dt2 = new DataTransfer();
          dt2.items.add(file);
          dz.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt2 }));
        }
        return { ok: fi.files.length > 0 };
      }, Array.from(PNG));

      if (uploaded.ok) {
        // 5. POST to GPU endpoint
        try {
          out.submit = await pg.evaluate(async () => {
            const fi = document.getElementById("file-input");
            const fd = new FormData();
            fd.append("image", fi.files[0]);
            const gpu = window.FREE?.inferenceGpuUrl || "https://gpu4.free.ai";
            const f = document.getElementById("tool-form");
            f.querySelectorAll("select").forEach(s => {
              if (s.value && s.value !== "0") fd.append(s.id || s.name, s.value);
            });
            f.querySelectorAll("textarea").forEach(t => {
              if (t.value) fd.append(t.id || t.name, t.value);
            });
            f.querySelectorAll('input[type=text], input[type=number]').forEach(inp => {
              if (inp.value && inp.name) fd.append(inp.name, inp.value);
            });

            const resp = await fetch(gpu + "/v1/image/edit/", { method: "POST", body: fd });
            const body = await resp.text();
            let parsed; try { parsed = JSON.parse(body); } catch {}
            return { status: resp.status, bodyLen: body.length, bodyFirst: body.substring(0, 500), parsed };
          });
          out.status = out.submit.status === 429 ? "rate_limited_429" :
                       out.submit.error ? "fetch_error" : "submitted";
        } catch (e) {
          out.status = "submit_failed";
          out.error = e.message;
        }
      } else {
        out.status = "upload_failed";
      }
    } else {
      out.status = "no_file_input";
    }

    await pg.close();
  } catch (e) {
    out.status = "page_error";
    out.error = e.message;
    await pg.close().catch(() => {});
  }

  results.push(out);

  // Rate limit: 200ms between requests
  if (i < tools.length - 1) await new Promise(r => setTimeout(r, 200));
}

// Save
mkdirSync("./data", { recursive: true });
writeFileSync("./data/upload_tests.json", JSON.stringify(results, null, 2));

// Print summary
const files = results.filter(r => r.form?.has_file);
console.log(`\n\nResults: ${results.length} tools`);
console.log(`  With file input: ${files.length}`);
console.log(`  Submitted: ${files.filter(r=>r.status==="submitted").length}`);
console.log(`  Rate limited: ${files.filter(r=>r.status==="rate_limited_429").length}`);
console.log(`  Skipped (no file): ${results.filter(r=>r.status==="no_file_input").length}`);
console.log(`  Errors: ${results.filter(r=>r.status==="page_error"||r.status==="submit_failed"||r.status==="upload_failed").length}`);
console.log("\nSaved: data/upload_tests.json");

await browser.close();
