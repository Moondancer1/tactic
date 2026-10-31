# Builds server + web client into one image. Context: repository root.
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY shared shared
COPY server server
COPY client client
RUN npm run build -w server && npm run build -w client

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    STATIC_DIR=/app/public
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --no-audit --no-fund -w server --include-workspace-root=false \
    && npm cache clean --force
COPY --from=build /src/server/dist server/dist
COPY --from=build /src/client/dist public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
WORKDIR /app/server
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
