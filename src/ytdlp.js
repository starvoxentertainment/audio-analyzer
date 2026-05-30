import { spawn } from "node:child_process";
import { mkdtemp, stat, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20 MB
const YTDLP_TIMEOUT_MS = 120_000;

/**
 * Inspect a cookie file body for safe diagnostics. Never returns cookie values.
 */
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
  return {
    YT_COOKIES_set: hasEnv,
    YT_COOKIES_FILE_set: hasFileEnv,
    resolvedFile: file,
    inspection,
  };
}

/**
 * Resolve a cookies file path for yt-dlp.
 *
 * Priority:
 *   1. YT_COOKIES_FILE (already a path on disk)
 *   2. YT_COOKIES      (raw Netscape cookies in an env var) -> write to /tmp
 *
 * Returns null if no cookies are configured.
 */
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
        "[audio-analyzer] cookie file is missing the Netscape header line — yt-dlp will reject it"
      );
    }
    if (info.youtubeLines === 0) {
      console.warn(
        "[audio-analyzer] cookie file has no youtube.com entries — auth will fail"
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
 * Downloads bestaudio for a YouTube URL via yt-dlp, converted to MP3, into a
 * temp file. Returns the absolute path to the MP3. Caller is responsible for
 * unlinking it.
 */
export async function downloadAudio(youtubeUrl) {
  const dir = await mkdtemp(path.join(tmpdir(), "ytdl-"));
  const outTemplate = path.join(dir, "audio.%(ext)s");
  const outPath = path.join(dir, "audio.mp3");

  const args = [
    "-f",
    "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "5",
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--quiet",
    "--max-filesize",
    "25M",
    "--retries",
    "3",
  ];

  const cookiesFile = await resolveCookiesFile();
  let cookiesNote = "";
  if (cookiesFile) {
    args.push("--cookies", cookiesFile);
    cookiesNote = `cookies=${cookiesFile}`;
  } else {
    cookiesNote = "cookies=NONE";
    console.warn(
      "[audio-analyzer] no cookies configured (YT_COOKIES or YT_COOKIES_FILE) — YouTube bot-check is likely to fail"
    );
  }
  args.push("-o", outTemplate, youtubeUrl);

  await new Promise((resolve, reject) => {
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
          .map((line) => line.trim())
          .filter(Boolean)
          .filter((line) => !line.startsWith("WARNING:"));
        const snippet = (lines.length ? lines : stderr.split("\n").filter(Boolean))
          .slice(-4)
          .join(" | ");
        return reject(
          new Error(
            `ytdlp_exit_${code}: [${cookiesNote}] ${snippet.slice(0, 300)}`
          )
        );
      }
      resolve();
    });
  });

  const s = await stat(outPath).catch(() => null);
  if (!s) throw new Error("ytdlp_no_output_file");
  if (s.size > MAX_AUDIO_BYTES) throw new Error("ytdlp_audio_too_large");

  return outPath;
}
