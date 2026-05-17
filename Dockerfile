FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY public ./public
COPY src ./src
COPY tsconfig.json ./

ENV HOST=0.0.0.0
ENV PORT=3070
EXPOSE 3070

CMD ["bun", "run", "start"]
