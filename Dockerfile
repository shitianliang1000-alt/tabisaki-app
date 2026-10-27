# 旅さきの手元用 API サーバー（docs/self-hosting.md）
#     docker compose up
# 依存パッケージはありません。エンジン（packages/core/）と収録データ（kb/）だけを入れます。
FROM node:22-alpine
WORKDIR /app
COPY kb ./kb
COPY packages ./packages
COPY package.json LICENSE ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8787/health >/dev/null || exit 1
CMD ["node", "packages/server/server.mjs"]
