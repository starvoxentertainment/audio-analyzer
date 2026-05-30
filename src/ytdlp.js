import { spawn } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20 MB
const YTDLP_TIMEOUT_MS = 60_000;

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
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "5", // ~128 kbps VBR is plenty for analysis
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--no-call-home",
    "--quiet",
    "--max-filesize",
    "25M",
    "--retries",
    "3",
    // Workaround for YouTube's "Sign in to confirm you're not a bot" check
    // on datacenter IPs. The default web client is now bot-checked; switch
    // to client variants that currently bypass it. See yt-dlp #14198 / #14693.
    "--extractor-args",
    "youtube:player_client=tv_simply,web_safari,mweb",
  ];
  if (process.env.YT_COOKIES_FILE) {
    args.push("--cookies", process.env.YT_COOKIES_FILE);
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
        const snippet = stderr.split("\n").filter(Boolean).slice(-3).join(" | ");
        return reject(new Error(`ytdlp_exit_${code}: ${snippet.slice(0, 200)}`));
      }
      resolve();
    });
  });

  const s = await stat(outPath).catch(() => null);
  if (!s) throw new Error("ytdlp_no_output_file");
  if (s.size > MAX_AUDIO_BYTES) throw new Error("ytdlp_audio_too_large");

  return outPath;
}
