FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS dependencies

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM dependencies AS test
USER root
RUN apk add --no-cache curl wget
RUN bun install --frozen-lockfile
COPY public ./public
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
CMD ["bun", "test"]

FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a

WORKDIR /app
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun public ./public
COPY --chown=bun:bun src ./src
RUN mkdir -p /app/data && chown bun:bun /app/data

ENV HOST=0.0.0.0
ENV PORT=3070
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
EXPOSE 3070
USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e 'const r = await fetch("http://127.0.0.1:" + (process.env.PORT || "3070") + "/healthz"); if (!r.ok) process.exit(1)'

CMD ["bun", "run", "start"]
