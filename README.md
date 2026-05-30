# audio-analyzer

External Node.js service that does the YouTube → audio → analysis pipeline that
can't run inside a Cloudflare Worker. The Lovable app (Cloudflare Worker) calls
this over HTTP and stores the result in `track_lighting`.

## What it does

`POST /analyze` with `{ "youtubeUrl": "..." }`:

1. `yt-dlp -x --audio-format mp3` → temp MP3 (capped at 20 MB / 60 s).
2. `ffmpeg` decode to PCM + `music-tempo` for BPM / beat grid.
3. `google/gemini-2.5-pro` via the Lovable AI Gateway on the MP3 bytes for
   sections (intro/verse/chorus/drop/…) + punctuated hits (stabs, drops,
   riser peaks, etc.).
4. Returns the JSON the Worker's `audioAnalysisSchema` expects.

`GET /health` → `{ ok: true }`.

## Required environment variables

| Name              | Required | Purpose                                                                 |
| ----------------- | -------- | ----------------------------------------------------------------------- |
| `LOVABLE_API_KEY` | yes      | Same key used in the Lovable app. Calls the AI Gateway for Gemini.      |
| `SHARED_SECRET`   | no       | If set, `/analyze` requires `Authorization: Bearer <SHARED_SECRET>`.    |
| `PORT`            | no       | Defaults to `8080` (Railway/Render inject their own).                   |

In the Lovable app, set:

- `AUDIO_ANALYZER_URL` → the service's public base URL (e.g. `https://...up.railway.app`).
- `AUDIO_ANALYZER_SECRET` → same value as `SHARED_SECRET` (only if you set one).

## Deploy: Railway

1. Push this repo (or just `services/audio-analyzer/`) to GitHub.
2. New Railway project → Deploy from GitHub repo → pick this repo.
3. Set **Root Directory** to `services/audio-analyzer`. Railway detects the
   `Dockerfile` automatically.
4. Add environment variables: `LOVABLE_API_KEY` (required) and
   `SHARED_SECRET` (recommended — generate a random 32-char string).
5. Deploy. Copy the generated public URL.
6. In Lovable Cloud secrets, set `AUDIO_ANALYZER_URL` and (if used)
   `AUDIO_ANALYZER_SECRET`.

## Deploy: Render

1. New → Web Service → connect repo.
2. Root Directory: `services/audio-analyzer`. Runtime: Docker.
3. Add env vars as above. Free plan works for testing; expect cold starts.

## Smoke test

```bash
curl -s -X POST https://your-service.up.railway.app/analyze \
  -H "Authorization: Bearer $SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"youtubeUrl":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}' | jq .
```

Expected: JSON with `bpm`, `beats_per_bar`, `mood`, `energy`, `sections[]`,
`hits[]`.

## Notes / trade-offs

- yt-dlp can be blocked by YouTube on big-cloud IPs. If you see frequent
  `ytdlp_exit_*` errors with "Sign in to confirm you're not a bot", deploy on
  a provider whose IPs aren't blanket-banned (Hetzner, Fly, OVH, a small VPS)
  or add `--cookies` to `yt-dlp` args.
- The container bundles a pinned `yt-dlp` binary downloaded at build time.
  Rebuild the image periodically to pick up upstream fixes.
- This service is intentionally stateless — no DB, no cache, no auth beyond
  the optional shared secret. The Lovable app caches results in `track_lighting`.
