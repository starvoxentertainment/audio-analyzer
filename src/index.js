import express from "express";
import { z } from "zod";
import { chmodSync, writeFileSync } from "node:fs";
import { downloadAudio, getCookieDiagnostics } from "./ytdlp.js";
import { analyzeAudio } from "./analyze.js";

const PORT = Number(process.env.PORT) || 8080;
const SHARED_SECRET = process.env.SHARED_SECRET || "";
const COOKIES_ENV_PATH = "/tmp/youtube-cookies.txt";

function materializeCookiesEnv() {
  if (process.env.YT_COOKIES_FILE || !process.env.YT_COOKIES) return;
  const raw = process.env.YT_COOKIES;
  const withNewlines = raw.includes("\\n") && !raw.includes("\n")
    ? raw.replace(/\\n/g, "\n")
    : raw;
  const body = withNewlines.replace(/\r\n/g, "\n").trimEnd() + "\n";
  try {
    writeFileSync(COOKIES_ENV_PATH, body, { encoding: "utf8", mode: 0o600 });
    chmodSync(COOKIES_ENV_PATH, 0o600);
    process.env.YT_COOKIES_FILE = COOKIES_ENV_PATH;
    console.log("[audio-analyzer] YouTube cookies configured from YT_COOKIES");
  } catch (err) {
    console.error("[audio-analyzer] failed to write YT_COOKIES", err?.message || err);
  }
}

materializeCookiesEnv();

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", async (_req, res) => {
  const cookies = await getCookieDiagnostics();
  res.json({ ok: true, cookies });
});

const RequestSchema = z.object({
  youtubeUrl: z
    .string()
    .url()
    .regex(/youtu\.?be/i, "Must be a YouTube URL"),
});

const ANALYZE_TIMEOUT_MS = 170_000;

app.post("/analyze", async (req, res) => {
  if (SHARED_SECRET) {
    const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (got !== SHARED_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  const parsed = RequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
  }

  const { youtubeUrl } = parsed.data;
  let audioPath;
  let responded = false;

  const hardTimer = setTimeout(() => {
    if (!responded) {
      responded = true;
      console.error("[analyze] hard timeout", youtubeUrl);
      res.status(504).json({ error: "analyzer_hard_timeout" });
    }
  }, ANALYZE_TIMEOUT_MS);

  try {
    audioPath = await downloadAudio(youtubeUrl);
    const analysis = await analyzeAudio(audioPath, youtubeUrl);
    if (!responded) {
      responded = true;
      return res.json(analysis);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[analyze] failed", youtubeUrl, msg);
    if (!responded) {
      responded = true;
      const status = msg.startsWith("ytdlp_") ? 502 : 500;
      return res.status(status).json({ error: msg.slice(0, 300) });
    }
  } finally {
    clearTimeout(hardTimer);
    if (audioPath) {
      await import("node:fs/promises")
        .then((fs) => fs.unlink(audioPath).catch(() => {}));
    }
  }
});

app.listen(PORT, () => {
  console.log(`[audio-analyzer] listening on :${PORT}`);
});
