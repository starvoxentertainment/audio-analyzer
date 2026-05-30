import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import MusicTempo from "music-tempo";

const SYSTEM_PROMPT = `You are a music analyst. You will receive an audio file of a song. Listen end-to-end and return a JSON description of its structure with millisecond-accurate timestamps.

CRITICAL:
- Timestamps are in milliseconds from the start of the audio.
- Sections must be contiguous and cover the whole track (end_ms of one = start_ms of next).
- Use musical section kinds: intro, verse, pre-chorus, chorus, post-chorus, bridge, breakdown, drop, build, solo, instrumental, outro.
- intensity is 1-10 (1 = whisper-quiet, 10 = peak).
- Identify PUNCTUATED HITS: drum stabs at end of chorus, beat drops, riser peaks, sudden silences, final stinger chord. These drive flashes. Be generous — capture every clear sonic event the audience would notice.
- bpm: integer 40-220.
- beats_per_bar: 3, 4, or 6 (almost always 4).
- Return ONLY valid JSON matching the requested shape. No prose.`;

const USER_TEXT = `Analyze the song and return JSON with this shape:
{
  "bpm": number,
  "beats_per_bar": 3 | 4 | 6,
  "mood": "short phrase",
  "energy": 1-10,
  "sections": [
    { "start_ms": number, "end_ms": number, "kind": "intro|verse|pre-chorus|chorus|post-chorus|bridge|breakdown|drop|build|solo|instrumental|outro", "intensity": 1-10, "label": "optional" }
  ],
  "hits": [
    { "at_ms": number, "kind": "drop|stab|riser_peak|silence|final_hit|snare_roll_end|vocal_cue", "intensity": 1-10, "note": "optional short" }
  ]
}`;

/**
 * Decode an MP3 file to mono 22050 Hz Float32 PCM using ffmpeg.
 */
function decodePcm(mp3Path) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-i",
      mp3Path,
      "-ac",
      "1",
      "-ar",
      "22050",
      "-f",
      "f32le",
      "pipe:1",
    ];
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    ff.on("error", (e) => reject(new Error(`ffmpeg_spawn_failed: ${e.message}`)));
    ff.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg_exit_${code}: ${stderr.slice(0, 200)}`));
      }
      const buf = Buffer.concat(chunks);
      const samples = new Float32Array(
        buf.buffer,
        buf.byteOffset,
        Math.floor(buf.byteLength / 4),
      );
      resolve(samples);
    });
  });
}

function chunkedBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

async function callGemini(audioBytes) {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("missing_LOVABLE_API_KEY");

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-pro",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: USER_TEXT },
            {
              type: "input_audio",
              input_audio: { data: chunkedBase64(audioBytes), format: "mp3" },
            },
          ],
        },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`gemini_http_${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error("gemini_empty_content");
  try {
    return JSON.parse(content);
  } catch {
    throw new Error("gemini_invalid_json");
  }
}

function clampInt(n, min, max, fallback) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

/**
 * Full audio analysis pipeline for a downloaded MP3.
 */
export async function analyzeAudio(mp3Path, _youtubeUrl) {
  // 1. Decode + BPM via music-tempo
  let bpm = null;
  try {
    const samples = await decodePcm(mp3Path);
    // music-tempo expects a plain array.
    const mt = new MusicTempo(Array.from(samples));
    if (Number.isFinite(mt?.tempo)) {
      bpm = clampInt(mt.tempo, 40, 220, null);
    }
  } catch (e) {
    console.warn("[analyze] music-tempo failed", e?.message || e);
  }

  // 2. Gemini structural analysis on the MP3 bytes
  const mp3Bytes = await readFile(mp3Path);
  const gemini = await callGemini(mp3Bytes);

  // 3. Merge — prefer Gemini's bpm/mood/energy, fall back to music-tempo.
  const merged = {
    bpm: clampInt(gemini.bpm ?? bpm, 40, 220, bpm ?? 120),
    beats_per_bar: [3, 4, 6].includes(Number(gemini.beats_per_bar))
      ? Number(gemini.beats_per_bar)
      : 4,
    mood: typeof gemini.mood === "string" && gemini.mood ? gemini.mood : "neutral",
    energy: clampInt(gemini.energy, 1, 10, 5),
    sections: Array.isArray(gemini.sections) ? gemini.sections : [],
    hits: Array.isArray(gemini.hits) ? gemini.hits : [],
  };

  return merged;
}
