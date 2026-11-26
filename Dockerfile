# whisper.cpp for the speech image, built on the same Debian as Bun's image. Tuned to the CPU it's built on, which is
# the one it runs on when built from source.
FROM oven/bun:1 AS whisper
ARG WHISPER_VERSION=v1.9.6
ARG WHISPER_MODEL=small.en
RUN apt-get update \
	&& apt-get install -y --no-install-recommends build-essential cmake git ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$WHISPER_VERSION" https://github.com/ggml-org/whisper.cpp /src \
	&& cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF \
		-DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF \
	&& cmake --build /build -j"$(nproc)" --target whisper-cli \
	&& mkdir /models \
	&& curl -fsSL -o "/models/ggml-$WHISPER_MODEL.bin" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$WHISPER_MODEL.bin"

FROM oven/bun:1 AS athena
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

# The speech image (`--target speech`): Athena with ffmpeg, which cuts the start of each chapter for Titles from the
# audio, and whisper.cpp with one model, to read them on this machine instead of with ElevenLabs.
FROM athena AS speech
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg libgomp1 \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=whisper /build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /models /models

# The plain image, without either: the default.
FROM athena
