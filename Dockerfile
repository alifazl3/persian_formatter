# --- build: compile the Go date-converter to WebAssembly ---
FROM golang:1.24-alpine AS wasm
WORKDIR /src
COPY dateservice/go.mod dateservice/go.sum ./
RUN go mod download
COPY dateservice/ ./
RUN GOOS=js GOARCH=wasm go build -o /out/date.wasm ./wasm \
 && (cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" /out/ 2>/dev/null \
     || cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" /out/)

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
# Go→WASM date converter assets, served at /date.wasm and /wasm_exec.js.
COPY --from=wasm /out/date.wasm /app/public/date.wasm
COPY --from=wasm /out/wasm_exec.js /app/public/wasm_exec.js

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["node", "dist/server.js"]
