import { spawn } from "node:child_process";
import { mkdtemp, stat, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20 MB
const YTDLP_TIMEOUT_MS = 120_000;

// Recent Chrome desktop UA — should match what cookies were exported from.
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Fallback ladder of yt-dlp player clients. `web` works best with cookies on
// datacenter IPs. If YouTube bot-checks one, we retry with the next.
const PLAYER_CLIENT_LADDER = [
  "web,mweb",
  "tv_embedded",
  "ios",
  "android",
];

function inspectCookieBody(body) {
  const lines = body.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const dataLines = nonEmpty.filter((l) => !l.startsWith("#"));
  const youtubeLines = dataLines.filter((l) => /youtube\.com/i.test(l));
  const hasNetscapeHeader = /Netscape HTTP Cookie File/i.test(lines[0] || "");
  const cookieNames = new Set();
  for (const line of dataLines) {
    const parts = line.split("\t");
    if (parts.length >= 6) cookieNames.add(parts[5]);
  }
  const importantPresent = [
    "SID","HSID","SSID","APISID","SAPISID",
    "__Secure-1PSID","__Secure-3PSID","LOGIN_INFO",
  ].filter((n) => cookieNames.has(n));
  return {
    bytes: body.length,
    totalLines: lines.length,
    dataLines: dataLines.length,
    youtubeLines: youtubeLines.length,
    hasNetscapeHeader,
    importantCookies: importantPresent,
  };
}

export async function getCookieDiagnostics() {
  const hasEnv = !!process.env.YT_COOKIES;
  const hasFileEnv = !!process.env.YT_COOKIES_FILE;
  let file = null;
  let inspection = null;
  try {
    const resolved = await resolveCookiesFile();
    if (resolved) {
      file = resolved;
      const body = await readFile(resolved, "utf8").catch(() => "");
      if (body) inspection = inspectCookieBody(body);
    }
  } catch {}
  return { YT_COOKIES_set: hasEnv, YT_COOKIES_FILE_set: hasFileEnv, resolvedFile: file, inspection };
}

async function resolveCookiesFile() {
  if (process.env.YT_COOKIES_FILE) return process.env.YT_COOKIES_FILE;
  const raw = process.env.YT_COOKIES;
  if (!raw) return null;
  const withNewlines = raw.includes("\\n") && !raw.includes("\n") ? raw.replace(/\\n/g, "\n") : raw;
  const body = withNewlines.replace(/\r\n/g, "\n").trimEnd() + "\n";
  const cookiesPath = path.join(tmpdir(), "youtube-cookies.txt");
  try {
    await writeFile(cookiesPath, body, { encoding: "utf8", mode: 0o600 });
    await chmod(cookiesPath, 0o600);
    process.env.YT_COOKIES_FILE = cookiesPath;
    const info = inspectCookieBody(body);
    console.log("[audio-analyzer] cookies materialized from YT_COOKIES", JSON.stringify({ path: cookiesPath, ...info }));
    if (!info.hasNetscapeHeader) console.warn("[audio-analyzer] cookie file is missing the Netscape header line — yt-dlp will reject it");
    if (info.youtubeLines === 0) console.warn("[audio-analyzer] cookie file has no youtube.com entries — auth will fail");
    return cookiesPath;
  } catch (err) {
    console.error("[audio-analyzer] failed to write YT_COOKIES", err?.message || err);
    return null;
  }
}

function runYtDlp({ youtubeUrl, outTemplate, cookiesFile, playerClient }) {
  const args = [
    "-f", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
    "-x", "--audio-format", "mp3", "--audio-quality", "5",
    "--no-playlist", "--no-warnings", "--no-progress", "--quiet",
    "--max-filesize", "25M", "--retries", "3", "--geo-bypass",
    "--sleep-requests", "1", "--sleep-interval", "1", "--max-sleep-interval", "3",
    "--user-agent", DESKTOP_UA,
    "--add-header", "Accept-Language:en-US,en;q=0.9",
    "--extractor-args", `youtube:player_client=${playerClient}`,
  ];
  if (cookiesFile) args.push("--cookies", cookiesFile);
  args.push("-o", outTemplate, youtubeUrl);

  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, YTDLP_TIMEOUT_MS);
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`ytdlp_spawn_failed: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error("ytdlp_timeout"));
      if (code !== 0) {
        const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => !l.startsWith("WARNING:"));
        const snippet = (lines.length ? lines : stderr.split("\n").filter(Boolean)).slice(-4).join(" | ");
        const err = new Error(`ytdlp_exit_${code}: [client=${playerClient}] ${snippet.slice(0, 300)}`);
        err.stderr = stderr;
        return reject(err);
      }
      resolve();
    });
  });
}

function isRetryableBotError(err) {
  const msg = (err?.message || "") + " " + (err?.stderr || "");
  return /sign in to confirm|not a bot|HTTP Error 403|HTTP Error 429|player response|unable to extract|requested format is not available|consent\.youtube/i.test(msg);
}

export async function downloadAudio(youtubeUrl) {
  const dir = await mkdtemp(path.join(tmpdir(), "ytdl-"));
  const outTemplate = path.join(dir, "audio.%(ext)s");
  const outPath = path.join(dir, "audio.mp3");

  const cookiesFile = await resolveCookiesFile();
  if (!cookiesFile) {
    console.warn("[audio-analyzer] no cookies configured — YouTube bot-check is likely to fail");
  }

  const attempts = [];
  let lastErr = null;

  for (const playerClient of PLAYER_CLIENT_LADDER) {
    console.log(`[audio-analyzer] yt-dlp attempt client=${playerClient} cookies=${cookiesFile ? "yes" : "no"}`);
    try {
      await runYtDlp({ youtubeUrl, outTemplate, cookiesFile, playerClient });
      lastErr = null;
      break;
    } catch (err) {
      attempts.push(`${playerClient}:${(err.message || "").slice(0, 80)}`);
      lastErr = err;
      console.warn(`[audio-analyzer] yt-dlp failed client=${playerClient}: ${err.message}`);
      if (!isRetryableBotError(err)) break;
    }
  }

  if (lastErr) {
    const summary = attempts.join(" || ").slice(0, 400);
    throw new Error(`ytdlp_all_clients_failed: cookies=${cookiesFile ? "yes" : "no"} attempts=[${summary}]`);
  }

  const s = await stat(outPath).catch(() => null);
  if (!s) throw new Error("ytdlp_no_output_file");
  if (s.size > MAX_AUDIO_BYTES) throw new Error("ytdlp_audio_too_large");
  return outPath;
}
