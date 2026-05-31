FROM node:20-bookworm-slim

# Cache-bust so Railway re-downloads the latest yt-dlp on rebuild.
# Bump this value to force a fresh yt-dlp binary.
ARG YTDLP_REV=2026-05-31-1

# yt-dlp + ffmpeg + python (yt-dlp runs on python3)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && echo "yt-dlp rev: ${YTDLP_REV}" \
 && apt-get purge -y curl \
 && rm -rf /var/lib/apt/lists/*


WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/index.js"]
