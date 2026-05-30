import { spawn } from "node:child_process";
import { mkdtemp, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20 MB
const YTDLP_TIMEOUT_MS = 120_000;

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

  // Some hosts escape newlines as literal "\n". Restore real newlines.
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
    console.log("[audio-analyzer] YouTube cookies materialized from YT_COOKIES");
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
 *
 * Throws Error with messages prefixed `ytdlp_` so the HTTP layer can map
 * them to 502s.
 */
export async function downloadAudio(youtubeUrl) {
  const dir = await mkdtemp(path.join(tmpdir(), "ytdl-"));
  const outTemplate = path.join(dir, "audio.%(ext)s");
  const outPath = path.join(dir, "audio.mp3");

  const args = [
    // Explicit format ladder: prefer m4a, then webm, then any audio, then
    // fall back to a muxed stream. Pinning to mobile-only player_clients
    // (android/ios) was returning manifests with no plain audio stream,
    // causing "Requested format is not available". Let yt-dlp use its
    // default client ladder instead.
    "-f",
    "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "5", // ~128 kbps VBR is plenty for analysis
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
  if (cookiesFile) {
    args.push("--cookies", cookiesFile);
  } else {
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
        return reject(new Error(`ytdlp_exit_${code}: ${snippet.slice(0, 300)}`));
      }
      resolve();
    });
  });

  const s = await stat(outPath).catch(() => null);
  if (!s) throw new Error("ytdlp_no_output_file");
  if (s.size > MAX_AUDIO_BYTES) throw new Error("ytdlp_audio_too_large");

  return outPath;
}
