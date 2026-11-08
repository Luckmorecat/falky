# Builds the web client and serves it from Caddy. Build context: web/.
#   docker build -t falky-caddy web

FROM node:26.13.0-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global "$(node -p 'require("./package.json").packageManager')" && \
    pnpm install --frozen-lockfile
COPY . .
ARG VITE_DEV_STATS=false
ARG FALKY_BUILD_REVISION
ARG FALKY_BUILD_REF
RUN pnpm run build

FROM caddy:2.11.7@sha256:36c24ad91a7ff7bc4c87fe22bfa8df3c4b18da0773d73fc12ee2c52b98c0bb7e
COPY --from=build /src/dist /srv/web
COPY Caddyfile /etc/caddy/Caddyfile
COPY web.caddy /etc/caddy/web.caddy
