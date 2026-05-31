import { spawn } from "node:child_process";
import { mkdtemp, writeFile, chmod, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20 MB
const YTDLP_TIMEOUT_MS = 120_000;

// Recent Chrome desktop UA — should match what cookies were exported from.
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Browser-like headers to look like a logged-in Chrome session.
const BROWSER_HEADERS = [
  "Accept-Language:en-US,en;q=0.9",
  "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Encoding:gzip, deflate, br",
  "Origin:https://www.youtube.com",
  "Sec-Fetch-Site:same-origin",
  "Sec-Fetch-Mode:navigate",
  "Sec-Fetch-Dest:document",
  "Sec-Fetch-User:?1",
  "Upgrade-Insecure-Requests:1",
  "sec-ch-ua:\"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\", \"Google Chrome\";v=\"131\"",
  "sec-ch-ua-mobile:?0",
  "sec-ch-ua-platform:\"Windows\"",
];

// Fallback strategies. Each tries a different player_client + extractor combo.
const STRATEGIES = [
  { name: "web", playerClient: "web", playerSkip: null },
  { name: "web+skipconfigs", playerClient: "web", playerSkip: "configs" },
  { name: "web,mweb", playerClient: "web,mweb", playerSkip: null },
  { name: "tv_embedded", playerClient: "tv_embedded", playerSkip: null },
  { name: "ios", playerClient: "ios", playerSkip: null },
  { name: "android", playerClient: "android", playerSkip: null },
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
  const important = [
    "SID",
    "HSID",
    "SSID",
    "APISID",
    "SAPISID",
    "__Secure-1PSID",
    "__Secure-3PSID",
    "LOGIN_INFO",
  ].filter((n) => cookieNames.has(n));
  return {
    bytes: body.length,
    totalLines: lines.length,
    dataLines: dataLines.length,
    youtubeLines: youtubeLines.length,
    hasNetscapeHeader,
    importantCookies: important,
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
  return {
    YT_COOKIES_set: hasEnv,
    YT_COOKIES_FILE_set: hasFileEnv,
    resolvedFile: file,
    inspection,
  };
}

async function resolveCookiesFile() {
  if (process.env.YT_COOKIES_FILE) return process.env.YT_COOKIES_FILE;

  const raw = process.env.YT_COOKIES;
  if (!raw) return null;

  const withNewlines =
    raw.includes("\\n") && !raw.includes("\n")
      ? raw.replace(/\\n/g, "\n")
      : raw;
  const body = withNewlines.replace(/\r\n/g, "\n").trimEnd() + "\n";

  const cookiesPath = path.join(tmpdir(), "youtube-cookies.txt");
  try {
    await writeFile(cookiesPath, body, { encoding: "utf8", mode: 0o600 });
    await chmod(cookiesPath, 0o600);
    process.env.YT_COOKIES_FILE = cookiesPath;

    const info = inspectCookieBody(body);
    console.log(
      "[audio-analyzer] cookies materialized from YT_COOKIES",
      JSON.stringify({ path: cookiesPath, ...info })
    );
    if (!info.hasNetscapeHeader) {
      console.warn(
        "[audio-analyzer] cookie file missing Netscape header — yt-dlp will reject"
      );
    }
    if (info.youtubeLines === 0) {
      console.warn(
        "[audio-analyzer] cookie file has no youtube.com entries — auth will fail"
      );
    }
    if (info.importantCookies.length === 0) {
      console.warn(
        "[audio-analyzer] cookie file has no session cookies (SID/__Secure-*PSID) — bot-check will fail"
      );
    }
    return cookiesPath;
  } catch (err) {
    console.error(
      "[audio-analyzer] failed to write YT_COOKIES",
      err?.message || err
    );
    return null;
  }
}

/**
 * Run a single yt-dlp invocation. If `convert` is true, extracts to mp3 inline.
 * If false, downloads the original audio stream as-is.
 */
function runYtDlp({
  youtubeUrl,
  outTemplate,
  cookiesFile,
  strategy,
  convert,
}) {
  const args = [
    "-f",
    "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--quiet",
    "--max-filesize",
    "25M",
    "--retries",
    "3",
    "--geo-bypass",
    "--sleep-requests",
    "1",
    "--sleep-interval",
    "1",
    "--max-sleep-interval",
    "3",
    "--user-agent",
    DESKTOP_UA,
    "--referer",
    "https://www.youtube.com/",
  ];

  for (const h of BROWSER_HEADERS) {
    args.push("--add-header", h);
  }

  const extractorArgs = [`youtube:player_client=${strategy.playerClient}`];
  if (strategy.playerSkip) {
    extractorArgs.push(`youtube:player_skip=${strategy.playerSkip}`);
  }
  for (const ea of extractorArgs) {
    args.push("--extractor-args", ea);
  }

  if (convert) {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "5");
  }

  if (cookiesFile) {
    args.push("--cookies", cookiesFile);
  }
  args.push("-o", outTemplate, youtubeUrl);

  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, YTDLP_TIMEOUT_MS);

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`ytdlp_spawn_failed: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error("ytdlp_timeout"));
      if (code !== 0) {
        const lines = stderr
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .filter((l) => !l.startsWith("WARNING:"));
        const snippet = (lines.length ? lines : stderr.split("\n").filter(Boolean))
          .slice(-4)
          .join(" | ");
        const err = new Error(
          `ytdlp_exit_${code}: [${strategy.name}${convert ? "" : "+raw"}] ${snippet.slice(0, 300)}`
        );
        err.stderr = stderr;
        return reject(err);
      }
      resolve();
    });
  });
}

function isRetryableBotError(err) {
  const msg = (err?.message || "") + " " + (err?.stderr || "");
  return /sign in to confirm|not a bot|HTTP Error 403|HTTP Error 429|player response|unable to extract|requested format is not available|consent\.youtube/i.test(
    msg
  );
}

/**
 * Convert a downloaded audio file to mp3 using ffmpeg.
 */
function ffmpegToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-y", "-i", inputPath, "-vn", "-acodec", "libmp3lame", "-q:a", "5", outputPath],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (e) => reject(new Error(`ffmpeg_spawn_failed: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(`ffmpeg_exit_${code}: ${stderr.split("\n").slice(-3).join(" | ").slice(0, 300)}`)
        );
      }
      resolve();
    });
  });
}

async function findDownloadedFile(dir) {
  const files = await readdir(dir);
  const candidates = files.filter((f) => f.startsWith("audio."));
  if (!candidates.length) return null;
  const final = candidates.find((f) => !f.endsWith(".part")) || candidates[0];
  return path.join(dir, final);
}

export async function downloadAudio(youtubeUrl) {
  const dir = await mkdtemp(path.join(tmpdir(), "ytdl-"));
  const outTemplate = path.join(dir, "audio.%(ext)s");
  const outPath = path.join(dir, "audio.mp3");

  const cookiesFile = await resolveCookiesFile();
  if (!cookiesFile) {
    console.warn(
      "[audio-analyzer] no cookies configured — YouTube bot-check is likely to fail"
    );
  }

  const attempts = [];
  let success = false;
  let lastErr = null;

  // Phase 1: extract+convert in one shot (fast path).
  for (const strategy of STRATEGIES) {
    console.log(
      `[audio-analyzer] yt-dlp attempt strategy=${strategy.name} mode=extract cookies=${cookiesFile ? "yes" : "no"}`
    );
    try {
      await runYtDlp({
        youtubeUrl,
        outTemplate,
        cookiesFile,
        strategy,
        convert: true,
      });
      success = true;
      lastErr = null;
      break;
    } catch (err) {
      attempts.push(`${strategy.name}:${(err.message || "").slice(0, 80)}`);
      lastErr = err;
      console.warn(
        `[audio-analyzer] yt-dlp failed strategy=${strategy.name} mode=extract: ${err.message}`
      );
      if (!isRetryableBotError(err)) break;
    }
  }

  // Phase 2: download raw then ffmpeg locally (decoupled fallback).
  if (!success && isRetryableBotError(lastErr)) {
    for (const strategy of STRATEGIES) {
      console.log(
        `[audio-analyzer] yt-dlp attempt strategy=${strategy.name} mode=raw cookies=${cookiesFile ? "yes" : "no"}`
      );
      try {
        await runYtDlp({
          youtubeUrl,
          outTemplate,
          cookiesFile,
          strategy,
          convert: false,
        });
        const downloaded = await findDownloadedFile(dir);
        if (!downloaded) throw new Error("ytdlp_raw_no_output");
        if (downloaded !== outPath) {
          await ffmpegToMp3(downloaded, outPath);
        }
        success = true;
        lastErr = null;
        break;
      } catch (err) {
        attempts.push(`${strategy.name}+raw:${(err.message || "").slice(0, 80)}`);
        lastErr = err;
        console.warn(
          `[audio-analyzer] yt-dlp failed strategy=${strategy.name} mode=raw: ${err.message}`
        );
        if (!isRetryableBotError(err)) break;
      }
    }
  }

  if (!success) {
    const summary = attempts.join(" || ").slice(0, 600);
    throw new Error(
      `ytdlp_all_clients_failed: cookies=${cookiesFile ? "yes" : "no"} attempts=[${summary}]`
    );
  }

  return outPath;
}
