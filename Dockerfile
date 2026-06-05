FROM node:20-slim

# ── System packages ────────────────────────────────────────────────────────────
# ffmpeg   : video frame extraction + encoding
# python3  : runs processor.py (PIL frame rendering)
# fonts    : FreeSansBold used as fallback for Impact font on Linux
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*

# ── Python packages ────────────────────────────────────────────────────────────
# Pillow   : frame-by-frame subtitle rendering
# yt-dlp   : download audio from Instagram / YouTube URLs
RUN pip3 install --break-system-packages Pillow yt-dlp

# ── Node app ───────────────────────────────────────────────────────────────────
WORKDIR /app

# Install deps first (cached layer — only rebuilds when package.json changes)
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Build Next.js for production
RUN npm run build

# Render injects PORT at runtime; default to 3000
EXPOSE 3000
CMD ["npm", "start"]
