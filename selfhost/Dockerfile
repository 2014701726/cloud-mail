# 多阶段构建：在 Linux 容器里编译前端 + 打包 Worker，产物放到运行镜像。
FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# 先复制依赖清单，利用缓存
COPY mail-worker/package.json mail-worker/pnpm-lock.yaml mail-worker/pnpm-workspace.yaml ./mail-worker/
COPY mail-vue/package.json mail-vue/pnpm-lock.yaml mail-vue/pnpm-workspace.yaml ./mail-vue/

RUN cd mail-worker && (pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile) \
 && cd ../mail-vue && (pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile)

COPY mail-worker ./mail-worker
COPY mail-vue ./mail-vue
COPY selfhost ./selfhost

WORKDIR /app/selfhost
RUN node build.mjs


# 运行镜像：只保留 Miniflare 运行时与构建产物
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATA_DIR=data

WORKDIR /app

COPY selfhost/package.json ./selfhost/package.json
RUN cd selfhost && npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/selfhost/server.mjs ./selfhost/server.mjs
COPY --from=build /app/selfhost/smtp.mjs ./selfhost/smtp.mjs
COPY --from=build /app/selfhost/ingest.mjs ./selfhost/ingest.mjs
COPY --from=build /app/selfhost/build ./selfhost/build
COPY --from=build /app/mail-worker/dist ./mail-worker/dist

WORKDIR /app/selfhost
EXPOSE 8787
VOLUME ["/app/selfhost/data"]
CMD ["node", "server.mjs"]
