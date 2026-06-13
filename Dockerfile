# --- build: compile TypeScript ---
FROM node:20-alpine AS build
WORKDIR /app/server
COPY server/package.json ./
RUN npm install
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# --- production dependencies only ---
FROM node:20-alpine AS prod-deps
WORKDIR /app/server
COPY server/package.json ./
RUN npm install --omit=dev

# --- runtime ---
FROM node:20-alpine
WORKDIR /app/server
ENV NODE_ENV=production
ENV PORT=80
ENV PUBLIC_DIR=/app/public

COPY --from=prod-deps /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY server/package.json ./
# The static frontend lives in its own dir so only index.html is served.
COPY index.html /app/public/index.html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["node", "dist/server.js"]
