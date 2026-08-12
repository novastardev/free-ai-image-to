#!/usr/bin/env node

/**
 * free.ai Scraper API Server — Job Queue
 * 
 * POST /api/image/jobs        — Submit a task, get job_id immediately
 * GET  /api/image/jobs        — List all jobs (with optional ?status=...)
 * GET  /api/image/jobs/:id    — Get job status / result (polling)
 * GET  /api/image/jobs/:id/file/:filename  — Serve the output file
 * GET  /api/image/list        — List available tools and models
 * GET  /api/image/status      — Health check
 *
 * Usage: node api_server.mjs [--port 3030]
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, createReadStream as fsCreateReadStream } from "node:fs";

const WORKSPACE = join("/opt/baal-agent/workspace/freeai-scraping");
const SUBMIT_SCRIPT = join(WORKSPACE, "submit.js");
const PORT = parseInt(process.argv[2] || process.env.PORT || "3030");
const DATA_DIR = join(WORKSPACE, "data");
const TMP_DIR = join(WORKSPACE, "tmp");
const JOB_DIR = join(DATA_DIR, "jobs");
const JOB_DB_PATH = join(JOB_DIR, "jobs.json");

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });
mkdirSync(JOB_DIR, { recursive: true });

// ── Persistent job store ─────────────────────────────────────────

function loadJobs() {
  try {
    return JSON.parse(readFileSync(JOB_DB_PATH, "utf-8")) || [];
  } catch {
    return [];
  }
}

function saveJobs() {
  writeFileSync(JOB_DB_PATH, JSON.stringify(jobs, null, 2));
}

let jobs = loadJobs();
let jobCounter = jobs.length > 0
  ? Math.max(...jobs.map(j => parseInt(j.id.replace("job_", "")) || 0)) + 1
  : 1;

function createJob(status, payload) {
  const job = {
    id: "job_" + String(jobCounter++).padStart(4, "0"),
    status: status,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    payload: payload,
    result: null,
    output_file: null,
    error: null,
  };
  jobs.push(job);
  saveJobs();
  return job;
}

function findJob(id) {
  return jobs.find(j => j.id === id);
}

// ── Helpers ──────────────────────────────────────────────────────

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve(null); }
    });
  });
}

// Run submit.js as a subprocess — updates job in memory as it progresses
function runSubmit(jobId, args, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const job = findJob(jobId);
    if (!job) { resolve(null); return; }

    job.status = "running";
    job.started_at = new Date().toISOString();
    saveJobs();

    const proc = spawn("node", [SUBMIT_SCRIPT, ...args], {
      cwd: WORKSPACE,
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
      job.result = stdout;
      saveJobs();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    proc.on("close", (code) => {
      const saved = stdout.match(/Saved:\s*(.+)$/m)?.[1]?.trim();

      if (code === 0) {
        job.status = "completed";
        job.output_file = saved || null;
      } else {
        job.status = "failed";
        job.error = stderr || stdout;
      }

      job.finished_at = new Date().toISOString();
      job.result = stdout;
      saveJobs();

      resolve({ code, stdout, stderr, saved });
    });

    proc.on("error", (err) => {
      job.status = "failed";
      job.error = err.message;
      job.finished_at = new Date().toISOString();
      saveJobs();
      resolve({ code: null, stdout, stderr, error: err.message, saved: null });
    });

    setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
    }, timeoutMs);
  });
}

// ── Build submit.js args from request ───────────────────────────

function buildArgs(body) {
  const args = [body.tool];

  if (body.tool === "generate" && body.prompt) {
    args.push(body.prompt);
  } else if (["remove-bg", "upscale", "enhance", "object-remove", "edit"].includes(body.tool)) {
    if (body.file_url) {
      const safeName = body.file?.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
      const dest = join(TMP_DIR, `_${body.tool}_${Date.now()}_${safeName}`);
      args.push(dest);
      // Store download URL on args for async download
      args._downloadUrl = body.file_url;
    } else if (body.file) {
      args.push(body.file);
    } else {
      return { error: `"${body.tool}" requires 'file' (local path) or 'file_url'`, code: 400 };
    }
  } else if (body.tool === "face-swap") {
    if (body.file_url1) {
      const dest1 = join(TMP_DIR, `_face1_${Date.now()}`);
      args.push(dest1);
      args._downloadUrl1 = body.file_url1;
    } else if (body.file1) {
      args.push(body.file1);
    }
    if (body.file_url2) {
      const dest2 = join(TMP_DIR, `_face2_${Date.now()}`);
      args.push(dest2);
      args._downloadUrl2 = body.file_url2;
    } else if (body.file2) {
      args.push(body.file2);
    }
  }

  // Options
  if (body.output) args.push("--output", body.output);
  if (body.model) args.push("--model", body.model);
  if (body.aspect) args.push("--aspect", body.aspect);
  if (body.scale) args.push("--scale", String(body.scale));
  if (body.count) args.push("--count", String(body.count));
  if (body.negative) args.push("--negative", body.negative);
  if (body.mood) args.push("--mood", body.mood);

  return args;
}

// ── Handlers ─────────────────────────────────────────────────────

async function handleCreateJob(req, res) {
  const body = await readBody(req);

  if (!body?.tool) {
    return jsonResponse(res, 400, {
      error: "Missing 'tool' field",
      valid_tools: ["generate", "ai-art", "remove-bg", "upscale", "enhance", "object-remove", "face-swap", "edit", "background-remover"],
    });
  }

  const result = buildArgs(body);
  if (result.error) return jsonResponse(res, result.code, { error: result.error });

  // Create job
  const job = createJob("pending", { ...body });

  // Download file if needed, then start submit
  let fileArgs = [...result];
  if (result._downloadUrl) {
    try {
      const { spawn } = await import("child_process");
      await new Promise((resolve, reject) => {
        const dl = spawn("curl", ["-sL", "-f", "-o", fileArgs[1], result._downloadUrl]);
        dl.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Download failed with code ${code}`));
        });
      });
    } catch (err) {
      job.status = "failed";
      job.error = err.message;
      job.finished_at = new Date().toISOString();
      saveJobs();
      return jsonResponse(res, 500, {
        job: { id: job.id, status: job.status, error: err.message },
      });
    }
  }
  if (result._downloadUrl1) {
    try {
      const { spawn } = await import("child_process");
      await new Promise((resolve, reject) => {
        const dl = spawn("curl", ["-sL", "-f", "-o", fileArgs[1], result._downloadUrl1]);
        dl.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Download failed with code ${code}`));
        });
      });
    } catch (err) {
      job.status = "failed";
      job.error = err.message;
      job.finished_at = new Date().toISOString();
      saveJobs();
      return jsonResponse(res, 500, {
        job: { id: job.id, status: job.status, error: err.message },
      });
    }
  }
  if (result._downloadUrl2) {
    try {
      const { spawn } = await import("child_process");
      await new Promise((resolve, reject) => {
        const dl = spawn("curl", ["-sL", "-f", "-o", fileArgs[2], result._downloadUrl2]);
        dl.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Download failed with code ${code}`));
        });
      });
    } catch (err) {
      job.status = "failed";
      job.error = err.message;
      job.finished_at = new Date().toISOString();
      saveJobs();
      return jsonResponse(res, 500, {
        job: { id: job.id, status: job.status, error: err.message },
      });
    }
  }

  // Start submit async (non-blocking)
  setTimeout(() => {
    runSubmit(job.id, fileArgs);
  }, 50);

  // Return immediately
  return jsonResponse(res, 202, {
    message: "Job accepted. Poll for status.",
    job: {
      id: job.id,
      status: job.status,
      created_at: job.created_at,
    },
  });
}

async function handleListJobs(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const statusFilter = url.searchParams.get("status");

  let filtered = jobs;
  if (statusFilter) {
    filtered = jobs.filter(j => j.status === statusFilter);
  }

  const list = [...filtered].reverse().map(j => ({
    id: j.id,
    status: j.status,
    created_at: j.created_at,
    started_at: j.started_at,
    finished_at: j.finished_at,
    output_file: j.output_file,
    has_error: !!j.error,
    payload: {
      tool: j.payload?.tool || "unknown",
      prompt: j.payload?.prompt,
      file: j.payload?.file_url || j.payload?.file,
    },
  }));

  return jsonResponse(res, 200, { total: list.length, jobs: list });
}

async function handleGetJob(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const segments = url.pathname.split("/");
  const jobId = segments[4];

  if (!jobId) {
    return jsonResponse(res, 400, { error: "Missing job ID" });
  }

  const job = findJob(jobId);
  if (!job) {
    return jsonResponse(res, 404, { error: `Job '${jobId}' not found` });
  }

  const response = {
    id: job.id,
    status: job.status,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    payload: job.payload,
    output_file: job.output_file,
    log: job.result?.substring(0, 2000),
  };

  if (job.error) response.error = job.error;
  if (job.status === "completed" && job.output_file) {
    response.file_url = `/api/image/jobs/${job.id}/file/${job.output_file}`;
  }

  return jsonResponse(res, 200, response);
}

async function handleGetJobFile(req, res) {
  const segments = req.url.split("/");
  // /api/image/jobs/:id/file/:filename
  const jobId = segments[4];
  const filename = segments[6];

  if (!jobId || !filename) {
    return jsonResponse(res, 400, { error: "Missing job ID or filename" });
  }

  const job = findJob(jobId);
  if (!job) {
    return jsonResponse(res, 404, { error: "Job not found" });
  }

  if (job.output_file !== filename) {
    return jsonResponse(res, 403, { error: "Access denied. File does not belong to this job." });
  }

  const filePath = join(WORKSPACE, filename);

  if (!existsSync(filePath)) {
    return jsonResponse(res, 404, { error: "Output file not found. Job may have failed." });
  }

  const stat = statSync(filePath);

  // Detect content type
  let contentType = "application/octet-stream";
  try {
    const content = readFileSync(filePath, "utf-8");
    JSON.parse(content);
    contentType = "application/json";
  } catch {
    const ext = filename.split(".").pop()?.toLowerCase();
    const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
    contentType = mimeMap[ext] || contentType;
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Content-Disposition": `inline; filename="${filename}"`,
  });

  const stream = fsCreateReadStream(filePath);
  stream.pipe(res);
}

async function handleList(req, res) {
  const result = await runSubmit(["list"], 5000);
  const modelResult = await runSubmit(["models"], 5000);
  return jsonResponse(res, 200, { tools: result.stdout, models: modelResult.stdout });
}

async function handleStatus(req, res) {
  return jsonResponse(res, 200, {
    status: "running",
    submit_script: existsSync(SUBMIT_SCRIPT) ? "available" : "missing",
    chrome_binary: existsSync("/usr/bin/google-chrome-stable") ? "available" : "missing",
    workspace: WORKSPACE,
    uptime: process.uptime(),
    jobs: {
      total: jobs.length,
      running: jobs.filter(j => j.status === "running").length,
      pending: jobs.filter(j => j.status === "pending").length,
      completed: jobs.filter(j => j.status === "completed").length,
      failed: jobs.filter(j => j.status === "failed").length,
    },
  });
}

// ── Server ───────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  console.log(`${req.method} ${path} [${new Date().toISOString()}]`);

  try {
    if (req.method === "POST" && path === "/api/image/jobs") {
      await handleCreateJob(req, res);
    } else if (req.method === "GET" && path === "/api/image/jobs") {
      await handleListJobs(req, res);
    } else if (req.method === "GET" && path.startsWith("/api/image/jobs/") && !path.includes("/file/")) {
      await handleGetJob(req, res);
    } else if (req.method === "GET" && path.startsWith("/api/image/jobs/") && path.includes("/file/")) {
      await handleGetJobFile(req, res);
    } else if (req.method === "GET" && path === "/api/image/list") {
      await handleList(req, res);
    } else if (req.method === "GET" && path === "/api/image/status") {
      await handleStatus(req, res);
    } else {
      jsonResponse(res, 404, {
        error: "Not found",
        endpoints: {
          "POST /api/image/jobs":      "Submit task → job_id",
          "GET  /api/image/jobs":      "List jobs (?status=...)",
          "GET  /api/image/jobs/:id":  "Get job status (poll)",
          "GET  /api/image/jobs/:id/file/:file": "Download output",
          "GET  /api/image/list":      "List tools & models",
          "GET  /api/image/status":    "Health check",
        },
      });
    }
  } catch (err) {
    console.error("Error:", err.message);
    jsonResponse(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 free.ai Scraper API (job-based) at http://localhost:${PORT}`);
  console.log(`\n   POST /api/image/jobs       → { job_id, status }`);
  console.log(`   GET  /api/image/jobs       → list jobs`);
  console.log(`   GET  /api/image/jobs/:id   → { status, result, file_url }`);
  console.log(`   GET  /api/image/jobs/:id/file/:f  → download file`);
});
