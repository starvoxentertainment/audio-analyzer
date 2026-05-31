FROM node:20-bookworm-slim

ARG YTDLP_REV=nightly-2026-05-31-1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN curl -L \
    "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp?rev=${YTDLP_REV}" \
    -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && yt-dlp --version

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
