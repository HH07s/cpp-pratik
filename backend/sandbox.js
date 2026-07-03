"use strict";
/*
 * Sandbox katmanı — her çalıştırma bir "job" nesnesidir:
 *   const job = await sandbox.createJob(code);
 *   const { ok, output } = await job.compile();   // non-interaktif derleme
 *   const term = job.run({ cols, rows });          // node-pty süreci (onData/onExit/write)
 *   job.kill();                                    // hangi aşamada olursa olsun öldür
 *   await job.cleanup();                           // geçici dosyaları sil (idempotent)
 *
 * İki uygulama var, SANDBOX ortam değişkeniyle seçilir:
 *   SANDBOX=docker  → her derleme/çalıştırma ayrı, kısıtlanmış bir konteynerde (önerilen; VPS)
 *   SANDBOX=local   → doğrudan host'ta g++ + ulimit (Docker'ın OLMADIĞI PaaS'lar için;
 *                     izolasyon zayıftır, servis kendisi bir konteyner/microVM içinde olmalı)
 */

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const pty = require("node-pty");

const MODE = (process.env.SANDBOX || "docker").toLowerCase();
const RUNNER_IMAGE = process.env.RUNNER_IMAGE || "cpp-pratik-runner";
const JOBS_ROOT = process.env.JOBS_DIR || os.tmpdir();
const COMPILE_TIMEOUT_MS = parseInt(process.env.COMPILE_TIMEOUT_MS || "20000", 10);
const MEMORY_LIMIT = process.env.MEMORY_LIMIT || "256m";
const CPU_LIMIT = process.env.CPU_LIMIT || "0.5";
const PIDS_LIMIT = process.env.PIDS_LIMIT || "128";

const GXX_ARGS = ["-O2", "-std=c++17", "-fdiagnostics-color=never", "main.cpp", "-o", "main"];
const MAX_DIAG_BYTES = 64 * 1024; // derleyici çıktısı üst sınırı

function createSandbox() {
  if (MODE === "docker") return { mode: "docker", createJob: createDockerJob };
  if (MODE === "local") return { mode: "local", createJob: createLocalJob };
  throw new Error(`Bilinmeyen SANDBOX modu: "${MODE}" ("docker" ya da "local" olmalı)`);
}

/* ---------- ortak yardımcılar ---------- */

async function makeJobDir(code) {
  const dir = await fsp.mkdtemp(path.join(JOBS_ROOT, "cpp-run-"));
  await fsp.writeFile(path.join(dir, "main.cpp"), code, "utf8");
  return dir;
}

// Bir child process'in stdout+stderr'ini toplar, süre aşımında öldürür.
function collect(child, timeoutMs, onTimeout) {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    let settled = false;
    const cap = (chunk) => { if (out.length < MAX_DIAG_BYTES) out += chunk.toString("utf8"); };
    if (child.stdout) child.stdout.on("data", cap);
    if (child.stderr) child.stderr.on("data", cap);
    const t = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
      if (onTimeout) onTimeout();
    }, timeoutMs);
    const fin = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve({ code, output: out.slice(0, MAX_DIAG_BYTES), timedOut });
    };
    child.on("error", (e) => { out += "\n" + e.message; fin(-1); });
    child.on("close", (code) => fin(code === null ? -1 : code));
  });
}

function compileResult(res) {
  if (res.timedOut) return { ok: false, output: "Derleme zaman aşımına uğradı." };
  return {
    ok: res.code === 0,
    output: res.output || (res.code === 0 ? "" : "Derleme hatası (derleyici çıktı üretmedi)."),
  };
}

/* ---------- Docker sandbox ---------- */

function dockerKill(name) {
  execFile("docker", ["kill", name], () => {}); // konteyner yoksa sessizce geçer
}

async function createDockerJob(code) {
  const dir = await makeJobDir(code);
  // Konteynerdeki root olmayan kullanıcı (uid 10001) derlemede binary yazabilsin
  await fsp.chmod(dir, 0o777);
  const name = "cppr-" + crypto.randomBytes(6).toString("hex");
  let compileChild = null;
  let term = null;
  let cleaned = false;

  const commonArgs = [
    "--network=none",
    `--memory=${MEMORY_LIMIT}`,
    `--memory-swap=${MEMORY_LIMIT}`, // swap yok — RAM limiti gerçek limit
    `--cpus=${CPU_LIMIT}`,
    `--pids-limit=${PIDS_LIMIT}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=32m",
    "-w", "/box",
  ];

  return {
    dir,

    async compile() {
      compileChild = spawn(
        "docker",
        ["run", "--rm", "--name", `${name}-c`, ...commonArgs, "-v", `${dir}:/box`, RUNNER_IMAGE, "g++", ...GXX_ARGS],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      const res = await collect(compileChild, COMPILE_TIMEOUT_MS, () => dockerKill(`${name}-c`));
      compileChild = null;
      return compileResult(res);
    },

    run({ cols, rows }) {
      // Dış PTY'yi node-pty sağlar; "-t" konteyner içinde de TTY açar,
      // böylece cout satır-tamponlu olur ve "Isim: " anında görünür.
      term = pty.spawn(
        "docker",
        ["run", "--rm", "-i", "-t", "--name", name, ...commonArgs, "-v", `${dir}:/box:ro`, RUNNER_IMAGE, "./main"],
        { name: "xterm-256color", cols, rows, cwd: dir, env: process.env }
      );
      return term;
    },

    kill() {
      dockerKill(name);
      dockerKill(`${name}-c`);
      if (compileChild) { try { compileChild.kill("SIGKILL"); } catch {} }
      if (term) { try { term.kill(); } catch {} }
    },

    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      dockerKill(name); // emniyet — normalde --rm zaten temizler
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

/* ---------- Local (Docker'sız) sandbox ---------- */

async function createLocalJob(code) {
  const dir = await makeJobDir(code);
  let compileChild = null;
  let term = null;
  let cleaned = false;

  return {
    dir,

    async compile() {
      compileChild = spawn("g++", GXX_ARGS, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      const res = await collect(compileChild, COMPILE_TIMEOUT_MS);
      compileChild = null;
      return compileResult(res);
    },

    run({ cols, rows }) {
      // ulimit'ler: core yok, dosya 10MB, 64 açık dosya, 256MB sanal bellek.
      // (-v bazı platformlarda desteklenmez → stderr bastırılır, komut devam eder.
      //  Duvar-saati zaman aşımını her durumda server.js uygular.)
      const script =
        "ulimit -c 0 2>/dev/null; ulimit -f 10240 2>/dev/null; " +
        "ulimit -n 64 2>/dev/null; ulimit -v 262144 2>/dev/null; exec ./main";
      term = pty.spawn("/bin/sh", ["-c", script], {
        name: "xterm-256color",
        cols,
        rows,
        cwd: dir,
        env: { PATH: "/usr/bin:/bin", HOME: dir, TERM: "xterm-256color" },
      });
      return term;
    },

    kill() {
      if (compileChild) { try { compileChild.kill("SIGKILL"); } catch {} }
      if (term) { try { term.kill("SIGKILL"); } catch {} }
    },

    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

module.exports = { createSandbox };
