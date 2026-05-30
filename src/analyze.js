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
