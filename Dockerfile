# Refresh this manifest digest deliberately when updating Node/security fixes.
FROM node:22-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9 AS base

# Bootstrap apt HTTPS from the pinned Node image's bundled Mozilla CA roots.
RUN node -e "const fs=require('node:fs'); fs.mkdirSync('/etc/ssl/certs',{recursive:true}); fs.writeFileSync('/etc/ssl/certs/ca-certificates.crt',require('node:tls').rootCertificates.join('\\n'))"

# Frozen Debian repositories make FFmpeg/Python dependency resolution traceable.
RUN rm -f /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261020T000000Z bookworm main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20261020T000000Z bookworm-security main' \
      > /etc/apt/sources.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts
# The official portable Python executable includes the matching EJS solver.
ADD https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp /tmp/yt-dlp
RUN echo '1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6  /tmp/yt-dlp' | sha256sum -c - \
    && chmod 755 /tmp/yt-dlp

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DOWNLOADER_TMP_DIR=/tmp/youtube-downloader XDG_CACHE_HOME=/tmp/.cache
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /tmp/yt-dlp /usr/local/bin/yt-dlp
COPY public ./public
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(async r=>{if(!r.ok || (await r.json()).ok!==true) process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
