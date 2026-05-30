import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import MusicTempo from "music-tempo";

export const ANALYSIS_PROMPT_VERSION = 3;

const SYSTEM_PROMPT = `You are the production designer doing a stadium walkthrough for ONE song.
You are NOT a generic music analyst — you are listening THROUGH the ears of a lighting
director who has to design 60,000-person arena cues for this exact track. Listen END-TO-END
(every second, not just the intro) and return a JSON report with millisecond-accurate
timestamps and stadium-grade specificity.

Work in FOUR explicit passes (silently — only the final JSON is returned):

PASS 1 — MACRO ARC
  Identify the overall song form: intro → verse(s) → pre-chorus(es) → chorus(es)
  → bridge → outro, etc. Count distinct choruses. Note where the song's
  emotional center of gravity sits (usually the bridge OR the final chorus).

PASS 2 — SECTION DETAIL
  Sections MUST be contiguous and cover the whole track (end_ms of one = start_ms of next).
  For every section, decide:
    - kind: intro|verse|pre-chorus|chorus|post-chorus|bridge|breakdown|drop|build|solo|instrumental|outro
    - variant (when applicable): "first" | "repeat" | "final" | "double" | "half-time" | "stripped" | "full"
      * "first" = first time we hear this section kind
      * "final" = the LAST chorus / last full section — typically loudest, most
        layered, often with ad-libs, key change, or extra hook
      * "double" = a chorus played twice back-to-back
      * "stripped" = the kind appears with fewer instruments (e.g. acoustic verse
        before final chorus, or piano-only bridge)
      * "half-time" = the drum feel halves; common in modern bridges
    - vocal: "lead" | "harmonized" | "acapella" | "instrumental" | "chant"
    - transition_in: how this section is ENTERED — "hard_cut" | "riser" | "sub_drop"
      | "vocal_chop" | "snare_roll" | "silence" | "fade" | null. These ARE the
      strobe/blackout moments.
    - intensity (1-10): RMS-perceived loudness/density. BUT also weight it by
      audience response — a stripped acoustic bridge can be a "9" if it's the
      moment 60,000 people sing the hook back. Recalibrate: 1-2 = whisper/blackout
      territory, 3-4 = mood verse, 5-6 = pre-chorus build, 7-8 = first/repeat chorus,
      9 = drop/double chorus, 10 = reserved for THE moment of the song.
    - label: a one-sentence LD RUN-SHEET NOTE, not a generic name. Write it the way
      a lighting director scribbles in their show book:
        BAD:  "first chorus"
        GOOD: "first chorus — band silhouetted upstage, audience blinders pop on
               every downbeat, magenta wash full"
        BAD:  "bridge"
        GOOD: "stripped bridge — single follow-spot on lead vocal stage-center,
               full blackout everywhere else, slow amber backlight breath"
      Mention: where the eye goes (vocalist? drummer? the crowd?), the dominant
      color feeling, and one concrete fixture move.

PASS 3 — HITS & ANCHORS (BIAS HARD TOWARD OVER-REPORTING)
  Sweep the timeline a SECOND time. Capture EVERY sonic event a stadium audience
  would notice. MANDATORY MINIMUMS:
    - >= 1 hit per 8 seconds of audio (a 3:30 song -> 25-35 hits, NOT 8).
    - >= 1 lyric_anchor per distinct chorus.
    - >= 1 "phone_moment" hit for any song with a recognizable hook.

  Hit kinds:
    drop | stab | riser_peak | silence | final_hit | snare_roll_end |
    vocal_cue | hook_word | breakdown_start | key_change | tempo_change |
    phone_moment | crowd_singalong_start | instrument_solo_start |
    instrument_solo_end | dynamic_dropout | tag_ending
    - phone_moment: the instant the crowd would raise phones/lighters
      (key change into final chorus, first hit of an iconic chorus, the
      "Whoa-oh" before the title drop, etc.).
    - dynamic_dropout: a beat where everything but ONE element drops out
      (just vocal, just kick, just bass). These are spotlight moments.
    - tag_ending: the extra outro after the "real" ending (e.g. the
      repeated chorus tag on "Hey Jude").

  Hit fields:
    - at_ms: millisecond timestamp
    - kind: from list above
    - subdivision (optional): "downbeat" | "upbeat" | "offbeat" | "syncopated"
    - intensity: 1-10
    - note: REQUIRED to be specific — name the instrument AND/OR the lyric word.
        BAD:  "loud part"
        GOOD: "snare crack + cymbal choke on the word 'baby!'"
        GOOD: "kick + sub-bass unison stab, lead vocal cuts out"
        GOOD: "final hook word 'heartbreaker' shouted, full band stops"

  LYRIC ANCHORS (3-10) — moments where a signature lyric phrase lands and a
  great show snaps to a new color. Pick the TITLE hook minimum, plus repeated
  signature phrases. For purely instrumental tracks, return an empty array.
    { at_ms: number, phrase: "short lyric snippet" }

PASS 4 — AUDIENCE LAYER
  Re-walk the song and decide, for each section: would the LD point the rig
  AT THE CROWD (audience blinders, phone moments, singalong), AT THE BAND
  (verses, solos, intimate bridges), or AT THE ARCHITECTURE (intros, ambient
  passages, post-final-chorus tag)? Fold this finding into the section's
  label and add a phone_moment hit at any audience-facing payoff point you
  haven't already captured.

GLOBAL:
  - bpm: integer 40-220 (your best estimate from the audio, not metadata).
  - beats_per_bar: 3, 4, or 6 (almost always 4; waltzes/ballads can be 3 or 6).
  - mood: short evocative phrase grounded in the actual sonics + lyric tone
    (e.g. "nocturnal yearning", "stadium triumph", "neon casino swagger").
  - energy: 1-10 overall.

OUTPUT: return ONLY valid JSON matching the requested shape. No prose, no markdown.`;

const USER_TEXT = `Analyze the song and return JSON with this exact shape:
{
  "bpm": number,
  "beats_per_bar": 3 | 4 | 6,
  "mood": "short phrase",
  "energy": 1-10,
  "sections": [
    {
      "start_ms": number,
      "end_ms": number,
      "kind": "intro|verse|pre-chorus|chorus|post-chorus|bridge|breakdown|drop|build|solo|instrumental|outro",
      "variant": "first|repeat|final|double|half-time|stripped|full" | null,
      "vocal": "lead|harmonized|acapella|instrumental|chant" | null,
      "transition_in": "hard_cut|riser|sub_drop|vocal_chop|snare_roll|silence|fade" | null,
      "intensity": 1-10,
      "label": "one-sentence LD run-sheet note — where the eye goes, dominant color, one fixture move"
    }
  ],
  "hits": [
    {
      "at_ms": number,
      "kind": "drop|stab|riser_peak|silence|final_hit|snare_roll_end|vocal_cue|hook_word|breakdown_start|key_change|tempo_change|phone_moment|crowd_singalong_start|instrument_solo_start|instrument_solo_end|dynamic_dropout|tag_ending",
      "subdivision": "downbeat|upbeat|offbeat|syncopated" | null,
      "intensity": 1-10,
      "note": "REQUIRED — name the instrument AND/OR lyric word"
    }
  ],
  "lyric_anchors": [
    { "at_ms": number, "phrase": "short lyric snippet" }
  ]
}

Few-shot example showing the DENSITY and SPECIFICITY expected (illustrative numbers
for a Queen "Bohemian Rhapsody"-style 0:00-1:30 fragment — your numbers come from
THIS audio):

{
  "sections": [
    { "start_ms": 0, "end_ms": 14000, "kind": "intro", "variant": "first", "vocal": "harmonized", "transition_in": null, "intensity": 3, "label": "acapella opening — full blackout, only a single warm key-light on the vocal harmonies, audience in total darkness" },
    { "start_ms": 14000, "end_ms": 48000, "kind": "verse", "variant": "first", "vocal": "lead", "transition_in": "fade", "intensity": 5, "label": "piano ballad verse — soft amber wash on the piano stage-right, deep midnight blue on the back truss, no audience light" },
    { "start_ms": 48000, "end_ms": 75000, "kind": "pre-chorus", "variant": "first", "vocal": "harmonized", "transition_in": "vocal_chop", "intensity": 7, "label": "Galileo build — moving heads start a slow scatter at the audience, color shifts purple-to-magenta on each Galileo, strobes prime" },
    { "start_ms": 75000, "end_ms": 90000, "kind": "drop", "variant": "first", "vocal": "lead", "transition_in": "hard_cut", "intensity": 10, "label": "rock-opera hard cut — full rig open, crimson red wash, audience blinders fire on every downbeat, full beam at the crowd" }
  ],
  "hits": [
    { "at_ms": 14200, "kind": "phone_moment", "subdivision": "downbeat", "intensity": 6, "note": "piano enters — audience would raise phones for the iconic chord" },
    { "at_ms": 25000, "kind": "vocal_cue", "subdivision": "downbeat", "intensity": 7, "note": "'Mama' — title-adjacent hook, lead vocal soars" },
    { "at_ms": 48000, "kind": "tempo_change", "subdivision": "downbeat", "intensity": 8, "note": "tempo doubles into Galileo section" },
    { "at_ms": 52000, "kind": "hook_word", "subdivision": "offbeat", "intensity": 8, "note": "'Galileo!' first call" },
    { "at_ms": 54000, "kind": "hook_word", "subdivision": "offbeat", "intensity": 8, "note": "'Galileo!' answer" },
    { "at_ms": 74500, "kind": "snare_roll_end", "subdivision": "downbeat", "intensity": 9, "note": "drum fill explodes into rock section" },
    { "at_ms": 75000, "kind": "drop", "subdivision": "downbeat", "intensity": 10, "note": "kick + full band hit on 'So you think you can stone me'" },
    { "at_ms": 75000, "kind": "phone_moment", "subdivision": "downbeat", "intensity": 10, "note": "the moment the entire stadium goes berserk" }
  ],
  "lyric_anchors": [
    { "at_ms": 22000, "phrase": "Mama, just killed a man" },
    { "at_ms": 52000, "phrase": "Galileo, Galileo" },
    { "at_ms": 75000, "phrase": "So you think you can stone me" }
  ]
}`;

function decodePcm(mp3Path) {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-i", mp3Path, "-ac", "1", "-ar", "22050", "-f", "f32le", "pipe:1"];
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (d) => { stderr += d.toString(); });
    ff.on("error", (e) => reject(new Error(`ffmpeg_spawn_failed: ${e.message}`)));
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg_exit_${code}: ${stderr.slice(0, 200)}`));
      const buf = Buffer.concat(chunks);
      const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
      resolve(samples);
    });
  });
}

function chunkedBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

async function callGeminiWithModel(audioBytes, model) {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("missing_LOVABLE_API_KEY");

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: USER_TEXT },
            { type: "input_audio", input_audio: { data: chunkedBase64(audioBytes), format: "mp3" } },
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

async function callGemini(audioBytes) {
  try {
    return await callGeminiWithModel(audioBytes, "google/gemini-2.5-pro");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== "gemini_empty_content") throw err;
    console.warn("[analyze] Gemini Pro returned empty content; retrying with Flash");
  }

  try {
    return await callGeminiWithModel(audioBytes, "google/gemini-2.5-flash");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "gemini_empty_content") throw new Error("gemini_empty_after_fallback");
    throw err;
  }
}

function clampInt(n, min, max, fallback) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

export async function analyzeAudio(mp3Path, _youtubeUrl) {
  let bpm = null;
  try {
    const samples = await decodePcm(mp3Path);
    const mt = new MusicTempo(Array.from(samples));
    if (Number.isFinite(mt?.tempo)) bpm = clampInt(mt.tempo, 40, 220, null);
  } catch (e) {
    console.warn("[analyze] music-tempo failed", e?.message || e);
  }

  const mp3Bytes = await readFile(mp3Path);
  const gemini = await callGemini(mp3Bytes);

  const merged = {
    bpm: clampInt(gemini.bpm ?? bpm, 40, 220, bpm ?? 120),
    beats_per_bar: [3, 4, 6].includes(Number(gemini.beats_per_bar)) ? Number(gemini.beats_per_bar) : 4,
    mood: typeof gemini.mood === "string" && gemini.mood ? gemini.mood : "neutral",
    energy: clampInt(gemini.energy, 1, 10, 5),
    sections: Array.isArray(gemini.sections) ? gemini.sections : [],
    hits: Array.isArray(gemini.hits) ? gemini.hits : [],
    lyric_anchors: Array.isArray(gemini.lyric_anchors) ? gemini.lyric_anchors : [],
    analysis_prompt_version: ANALYSIS_PROMPT_VERSION,
  };

  return merged;
}
