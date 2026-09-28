# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS dependencies
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS runtime
ARG SOURCE_REVISION
ARG APP_VERSION=v1.0
LABEL org.opencontainers.image.source="https://github.com/cubelightt/cs-arena" \
      org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.licenses="GPL-3.0-only"
ENV NODE_ENV=production PORT=8080
WORKDIR /app/backend
COPY --from=dependencies /app/backend/node_modules ./node_modules
COPY backend/package.json backend/package-lock.json ./
COPY backend/server.js backend/config.js backend/db.js ./
COPY backend/lib ./lib
COPY backend/routes ./routes
COPY backend/scripts/msm-stub.sh ./scripts/msm-stub.sh
COPY update/CHANGELOG.md /app/update/CHANGELOG.md
COPY LICENSE THIRD_PARTY_NOTICES.md /app/
RUN mkdir -p /var/lib/arena/demos /var/lib/arena/map-images \
    && chown -R node:node /var/lib/arena \
    && chmod +x ./scripts/msm-stub.sh
USER node
EXPOSE 8080
CMD ["node", "server.js"]
