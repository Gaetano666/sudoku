FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dipendenze prima del codice, per sfruttare la cache dei layer.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY server/src ./server/src
COPY server/scripts ./server/scripts
COPY public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server/src/server.js"]
