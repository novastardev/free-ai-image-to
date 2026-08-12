
import puppeteer from "puppeteer-core";
import { writeFileSync } from "fs";

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

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium-browser",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

// Get URLs
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

// Test first 3 tools sequentially
for (let i = 0; i < Math.min(3, tools.length); i++) {
  const tool = tools[i];
  console.log(`\n[${i+1}] ${tool.name}`);
  console.log("  URL:", tool.url);

  const p = await browser.newPage();
  await p.setUserAgent("Mozilla/5.0");

  try {
    console.log("  Navigating...");
    await p.goto(tool.url, { waitUntil: "domcontentloaded", timeout: 10000 });
    console.log("  Navigated OK");

    // Check form
    const form = await p.evaluate(() => {
      const f = document.querySelector("form");
      const fi = document.getElementById("file-input");
      return {
        hasForm: !!f,
        hasFileInput: !!fi,
        fileInputId: fi?.id,
        action: f?.action || "",
      };
    });
    console.log("  Form:", JSON.stringify(form));

    // Try upload
    if (form.hasFileInput) {
      console.log("  Uploading...");
      const uploadOk = await p.evaluate(async (bytes) => {
        const fi = document.getElementById("file-input");
        const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
        const file = new File([blob], "test.png", { type: "image/png" });
        const dt = new DataTransfer();
        dt.items.add(file);
        fi.files = dt.files;
        fi.dispatchEvent(new Event("change", { bubbles: true }));
        return fi.files.length > 0;
      }, Array.from(TEST_PNG));
      console.log("  Upload:", uploadOk);
    }

    await p.close();
    console.log("  ✓ Done");
  } catch (err) {
    console.log("  ✗ Error:", err.message);
    await p.close().catch(() => {});
  }
}

await browser.close();
console.log("\nDone!");
