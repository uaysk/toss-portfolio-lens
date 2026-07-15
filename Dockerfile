FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json tsconfig.server.json vite.config.ts tailwind.config.ts postcss.config.js index.html ./
COPY src ./src
COPY server ./server
RUN npm run typecheck
RUN npm test
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S portfolio && adduser -S portfolio -G portfolio
RUN mkdir -p /app/data && chown portfolio:portfolio /app/data
COPY --from=build --chown=portfolio:portfolio /app/package.json ./package.json
COPY --from=build --chown=portfolio:portfolio /app/node_modules ./node_modules
COPY --from=build --chown=portfolio:portfolio /app/dist ./dist
USER portfolio
EXPOSE 3200
CMD ["node", "dist/server/index.js"]
