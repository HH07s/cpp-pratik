"use strict";
/*
 * C++ Pratik — canlı terminal backend'i.
 * WebSocket üzerinden JSON mesajlarıyla çalışır:
 *   İstemci → Sunucu : {type:"run", code, cols?, rows?} | {type:"input", data} | {type:"kill"}
 *   Sunucu → İstemci : {type:"status", stage:"compiling"|"running"|"done"}
 *                      {type:"stdout", data} | {type:"compile_error", data}
 *                      {type:"exit", code}   | {type:"error", message}
 */

const http = require("http");
const { WebSocketServer } = require("ws");
const { createSandbox } = require("./sandbox");

const PORT = parseInt(process.env.PORT || "8080", 10);
const RUN_TIMEOUT_MS = parseInt(process.env.RUN_TIMEOUT_MS || "10000", 10);
const MAX_OUTPUT_BYTES = parseInt(process.env.MAX_OUTPUT_BYTES || String(1024 * 1024), 10);
const MAX_CODE_BYTES = parseInt(process.env.MAX_CODE_BYTES || String(128 * 1024), 10);
const MAX_CONCURRENT_RUNS = parseInt(process.env.MAX_CONCURRENT_RUNS || "4", 10);
const MIN_RUN_INTERVAL_MS = parseInt(process.env.MIN_RUN_INTERVAL_MS || "1000", 10);
const HEARTBEAT_MS = 30000;
// Boş bırakılırsa her origin kabul edilir; üretimde "https://kullanici.github.io" ver.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const sandbox = createSandbox();
let activeRuns = 0;

/* ---------- HTTP (sağlık kontrolü) ---------- */
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, sandbox: sandbox.mode, activeRuns }));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("cpp-pratik backend — WebSocket bekleniyor");
});

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, maxPayload: MAX_CODE_BYTES + 4096 });

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// ANSI kaçış dizilerini temizle (derleme hatası düz metin gösterilecek)
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const stripAnsi = (s) => String(s).replace(ANSI_RE, "");

const clampInt = (v, min, max, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

wss.on("connection", (ws, req) => {
  if (ALLOWED_ORIGINS.length) {
    const origin = req.headers.origin || "";
    if (!ALLOWED_ORIGINS.includes(origin)) {
      ws.close(1008, "origin not allowed");
      return;
    }
  }

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  const state = { busy: false, job: null, timer: null, lastRunAt: 0 };

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString("utf8")); } catch {
      return send(ws, { type: "error", message: "Geçersiz mesaj (JSON bekleniyor)." });
    }
    if (msg.type === "run") return void handleRun(ws, state, msg);
    if (msg.type === "input") {
      if (state.job && state.job.term && typeof msg.data === "string") state.job.term.write(msg.data);
      return;
    }
    if (msg.type === "kill") {
      if (state.job) state.job.kill();
      return;
    }
    send(ws, { type: "error", message: `Bilinmeyen mesaj tipi: ${msg.type}` });
  });

  ws.on("close", () => {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.job) state.job.kill(); // cleanup, run akışındaki onExit/kontrol noktalarında yapılır
  });
});

async function handleRun(ws, state, msg) {
  // Bağlantı başına tek çalıştırma + basit rate limit
  if (state.busy) return send(ws, { type: "error", message: "Zaten çalışan bir program var — önce onu durdur." });
  const now = Date.now();
  if (now - state.lastRunAt < MIN_RUN_INTERVAL_MS) return send(ws, { type: "error", message: "Çok sık istek — bir saniye bekle." });
  if (activeRuns >= MAX_CONCURRENT_RUNS) return send(ws, { type: "error", message: "Sunucu şu an dolu — birazdan tekrar dene." });
  if (typeof msg.code !== "string" || !msg.code.trim()) return send(ws, { type: "error", message: "Kod boş." });
  if (Buffer.byteLength(msg.code, "utf8") > MAX_CODE_BYTES) return send(ws, { type: "error", message: "Kod çok büyük (limit 128 KB)." });

  state.busy = true;
  state.lastRunAt = now;
  activeRuns++;

  let job = null;
  let counted = true;
  const done = () => {
    if (counted) { counted = false; activeRuns--; }
    state.busy = false;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    state.job = null;
    if (job) job.cleanup();
  };

  try {
    job = await sandbox.createJob(msg.code);
    state.job = job;

    send(ws, { type: "status", stage: "compiling" });
    const comp = await job.compile();
    if (ws.readyState !== ws.OPEN) return done();

    if (!comp.ok) {
      send(ws, { type: "compile_error", data: stripAnsi(comp.output) });
      send(ws, { type: "status", stage: "done" });
      return done();
    }

    send(ws, { type: "status", stage: "running" });
    const cols = clampInt(msg.cols, 20, 300, 80);
    const rows = clampInt(msg.rows, 5, 100, 24);
    const term = job.run({ cols, rows });
    job.term = term; // input mesajları için

    let outBytes = 0;
    let overflowed = false;
    state.timer = setTimeout(() => {
      send(ws, { type: "error", message: `Zaman aşımı (${Math.round(RUN_TIMEOUT_MS / 1000)} sn) — program sonlandırıldı.` });
      job.kill();
    }, RUN_TIMEOUT_MS);

    term.onData((data) => {
      if (overflowed) return;
      outBytes += Buffer.byteLength(data, "utf8");
      if (outBytes > MAX_OUTPUT_BYTES) {
        overflowed = true;
        send(ws, { type: "error", message: "Çıktı limiti (1 MB) aşıldı — program sonlandırıldı." });
        job.kill();
        return;
      }
      send(ws, { type: "stdout", data });
    });

    term.onExit(({ exitCode, signal }) => {
      // sinyalle ölen süreç için shell geleneği: 128 + sinyal (ör. SIGKILL → 137)
      send(ws, { type: "exit", code: signal ? 128 + signal : exitCode });
      send(ws, { type: "status", stage: "done" });
      done();
      if (overflowed) ws.close(1009, "output limit exceeded");
    });
  } catch (e) {
    console.error("[run] hata:", e);
    send(ws, { type: "error", message: "Sunucu hatası: " + (e && e.message ? e.message : "bilinmeyen") });
    if (job) job.kill();
    done();
  }
}

/* ---------- kopan bağlantıları ayıkla ---------- */
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`cpp-pratik backend :${PORT} — sandbox=${sandbox.mode}, timeout=${RUN_TIMEOUT_MS}ms, max ${MAX_CONCURRENT_RUNS} eşzamanlı çalıştırma`);
});
