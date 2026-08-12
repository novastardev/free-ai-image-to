
import puppeteer from "puppeteer-core";
import { writeFileSync } from "fs";
import { performance } from "perf_hooks";

const TEST_PNG = new Uint8Array([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xDE, 0x0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE,
  0xD4, 0xCB, 0x27, 0x9B, 0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
]);

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium-browser",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

const page0 = await browser.newPage();
await page0.setUserAgent("Mozilla/5.0");
await page0.goto("https://free.ai/tools/", { waitUntil: "domcontentloaded", timeout: 20000 });
const tools = await page0.evaluate(() => {
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
await page0.close();

console.log("Total tools:", tools.length);

// Test ALL tools, log timing for each step
for (let i = 0; i < tools.length; i++) {
  const tool = tools[i];
  const t0 = performance.now();
  
  const p = await browser.newPage();
  await p.setUserAgent("Mozilla/5.0");
  
  let t1 = performance.now();
  
  try {
    await p.goto(tool.url, { waitUntil: "domcontentloaded", timeout: 8000 });
    t1 = performance.now();
    // console.log(`${tool.name}: goto=${(t1-t0).toFixed(0)}ms`);
  } catch {
    t1 = performance.now();
    console.log(`[${i+1}/${tools.length}] ${tool.name}: GOTO FAILED`);
    await p.close().catch(() => {});
    if (i < 5) continue; // Continue but don't fail
  }
  
  // Check form
  const formCheck = await p.evaluate(() => {
    const f = document.querySelector("form");
    const fi = document.getElementById("file-input");
    return { hasFile: !!fi, hasForm: !!f };
  });
  const t2 = performance.now();
  
  let hasFile = formCheck.hasFile;
  
  if (hasFile) {
    // Try upload
    try {
      const uploadOk = await p.evaluate(async (bytes) => {
        const fi = document.getElementById("file-input");
        if (!fi) return false;
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
        return fi.files.length > 0;
      }, Array.from(TEST_PNG));
      const t3 = performance.now();
      
      if (uploadOk) {
        // Try fetch submit with timeout
        try {
          const result = await p.evaluate(async () => {
            const formEl = document.getElementById("tool-form");
            const fi = document.getElementById("file-input");
            const file = fi.files[0];
            const formData = new FormData();
            formData.append("image", file);
            const gpuUrl = window.FREE?.inferenceGpuUrl || "https://gpu4.free.ai";
            
            formEl.querySelectorAll("select").forEach(sel => {
              if (sel.value && sel.value !== "0") formData.append(sel.id || sel.name, sel.value);
            });
            
            try {
              const resp = await fetch(gpuUrl + "/v1/image/edit/", { method: "POST", body: formData });
              const body = await resp.text();
              let parsed; try { parsed = JSON.parse(body); } catch {}
              return { status: resp.status, bodyLen: body.length, parsed: parsed };
            } catch (err) {
              return { error: err.message };
            }
          });
          const t4 = performance.now();
          console.log(`[${i+1}/${tools.length}] ${tool.name}: ${result.status || result.error} (${(t4-t0).toFixed(0)}ms total)`);
        } catch (err) {
          const t3b = performance.now();
          console.log(`[${i+1}/${tools.length}] ${tool.name}: FETCH ERROR ${err.message.substring(0, 40)} (${(t3b-t0).toFixed(0)}ms)`);
        }
      } else {
        const t3 = performance.now();
        console.log(`[${i+1}/${tools.length}] ${tool.name}: UPLOAD FAILED (${(t3-t0).toFixed(0)}ms)`);
      }
    } catch (err) {
      console.log(`[${i+1}/${tools.length}] ${tool.name}: UPLOAD ERROR ${err.message.substring(0, 40)} (${(performance.now()-t0).toFixed(0)}ms)`);
    }
  }
  
  await p.close().catch(() => {});
  
  // Rate limit
  if (i < tools.length - 1) {
    await new Promise(r => setTimeout(r, 500));
  }
}

console.log("\nDone!");
