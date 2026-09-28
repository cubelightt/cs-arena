# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build
WORKDIR /build
COPY frontend_winui/package.json frontend_winui/package-lock.json ./
RUN npm ci
COPY frontend_winui/ ./
ENV VITE_API_BASE=""
RUN npm run build

FROM nginx:stable-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94 AS runtime
ARG SOURCE_REVISION
ARG APP_VERSION=v1.0
LABEL org.opencontainers.image.source="https://github.com/cubelightt/cs-arena" \
      org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.licenses="GPL-3.0-only"
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/dist /usr/share/nginx/html
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/cs-arena/
EXPOSE 80
