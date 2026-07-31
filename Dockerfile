# syntax=docker/dockerfile:1.7

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

FROM deps AS source
COPY tsconfig.json tsconfig.base.json tsconfig.app.json tsconfig.server.json tsconfig.scripts.json tsconfig.tests.json ./
COPY vite.config.ts tailwind.config.ts postcss.config.js index.html ./
COPY src ./src
COPY server ./server
COPY test-support ./test-support
COPY contracts ./contracts
COPY public ./public
COPY docs/mcp-chatgpt.md ./docs/mcp-chatgpt.md
COPY scripts/run-vitest-batches.mjs ./scripts/run-vitest-batches.mjs
COPY scripts/verify-runtime-modules.mjs ./scripts/verify-runtime-modules.mjs

FROM source AS verify
RUN npm run typecheck
RUN npm test

FROM source AS build
RUN npm run build

FROM deps AS prod-deps
RUN npm prune --omit=dev \
    && find node_modules -type f \
      \( -name '*.map' -o -name '*.ts' -o -name '*.d.ts' -o -name '*.md' \) \
      -delete \
    && find node_modules -type d \
      \( -name test -o -name tests -o -name docs -o -name examples \
         -o -name benchmark -o -name benchmarks \) \
      -prune -exec rm -rf '{}' + \
    && rm -rf node_modules/@types

FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce AS runtime-base
ARG APP_GIT_SHA=unknown
LABEL org.opencontainers.image.revision="${APP_GIT_SHA}"
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache ca-certificates libstdc++ \
    && addgroup -g 10001 -S portfolio \
    && adduser -u 10001 -S portfolio -G portfolio \
    && mkdir -p /app/data /app/run \
    && chown portfolio:portfolio /app/data /app/run
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
COPY --from=prod-deps --chown=portfolio:portfolio /app/package.json ./package.json
COPY --from=prod-deps --chown=portfolio:portfolio /app/node_modules ./node_modules
COPY --from=build --chown=portfolio:portfolio /app/dist ./dist
COPY --from=build --chown=portfolio:portfolio /app/scripts/verify-runtime-modules.mjs ./scripts/verify-runtime-modules.mjs
USER portfolio

FROM runtime-base AS runtime-verify
RUN node scripts/verify-runtime-modules.mjs

FROM runtime-base AS runtime
EXPOSE 3200
CMD ["node", "dist/server/index.js"]
