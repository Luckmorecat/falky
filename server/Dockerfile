# Builds the falky server image. Build context: server/.
#   docker build -t falky server

FROM golang:1.27.3-trixie@sha256:c65ecfe613b539ac74c62a4c3b2c27e8f8a6076384c8f27e8a3c0f3be17cc385 AS build
WORKDIR /src
COPY go.mod go.sum ./
COPY cmd ./cmd
COPY internal ./internal
RUN --mount=type=cache,target=/root/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/falky ./cmd/falky
# The database directory, owned by the runtime user.
RUN mkdir -p /out/data

FROM gcr.io/distroless/static-debian13:nonroot@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329
COPY --from=build /out/falky /falky
COPY --from=build --chown=nonroot:nonroot /out/data /data
USER nonroot:nonroot
ENV FALKY_PUBLIC_ADDR=:8080 \
    FALKY_INTERNAL_ADDR=:9090 \
    FALKY_DB_PATH=/data/falky.db
EXPOSE 8080 9090
ENTRYPOINT ["/falky"]
CMD ["serve"]
