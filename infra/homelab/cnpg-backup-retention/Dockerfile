FROM golang:1.26.5-alpine3.23@sha256:73f9732658b30852522ee5ebe698daa27e1829add9a70ff4f4a828409f8d0a99 AS build

WORKDIR /src
COPY go.mod main.go main_test.go ./
RUN go test ./... && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w -buildid=" -o /out/cnpg-backup-retention .

FROM scratch

ARG APP_GIT_SHA=unknown
LABEL org.opencontainers.image.title="toss-portfolio-lens CNPG backup retention" \
      org.opencontainers.image.description="Fail-closed retention for completed CNPG volume snapshot backups" \
      org.opencontainers.image.revision="${APP_GIT_SHA}" \
      org.opencontainers.image.source="https://github.com/uaysk/toss-portfolio-lens"

COPY --from=build /out/cnpg-backup-retention /cnpg-backup-retention

USER 65532:65532
ENTRYPOINT ["/cnpg-backup-retention"]
