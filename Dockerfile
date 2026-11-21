FROM oven/bun:1
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json entrypoint.sh ./
COPY public ./public
COPY src ./src
ENV PORT=8800 ATHENA_DATA=/data TZ=America/New_York
EXPOSE 8800
HEALTHCHECK --interval=60s --timeout=5s CMD curl -fsS http://localhost:8800/healthz || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "run", "src/main.ts"]
