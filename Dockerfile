FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.server.json vite.config.ts tailwind.config.ts postcss.config.js index.html ./
COPY src ./src
COPY server ./server
COPY contracts ./contracts
COPY docs/mcp-chatgpt.md ./docs/mcp-chatgpt.md
RUN npm run typecheck
RUN npm test
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -g 10001 -S portfolio && adduser -u 10001 -S portfolio -G portfolio
RUN mkdir -p /app/data /app/run && chown portfolio:portfolio /app/data /app/run
COPY --from=build --chown=portfolio:portfolio /app/package.json ./package.json
COPY --from=build --chown=portfolio:portfolio /app/node_modules ./node_modules
COPY --from=build --chown=portfolio:portfolio /app/dist ./dist
USER portfolio
EXPOSE 3200
CMD ["node", "dist/server/index.js"]
