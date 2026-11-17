# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-slim

# --- Abhängigkeiten installieren -------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 bringt fertige Binärdateien mit; Installationsskripte werden nicht gebraucht.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# --- Laufzeit-Image ----------------------------------------------------------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    TZ=Europe/Berlin
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# Die Anwendung läuft ohne Root-Rechte; alle Daten liegen im Volume /data.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
