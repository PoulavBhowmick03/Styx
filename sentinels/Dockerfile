# Sentinels as a service (styx-sentinels serve). Build from the repo root, which holds both the agent
# CLI that signs sentinel_pause (sdk/near) and the runner (sentinels):
#   docker build -f sentinels/Dockerfile .
#   fly deploy . --config sentinels/fly.toml --dockerfile sentinels/Dockerfile
# No key is baked in: the service makes each vault's sentinel keys at run time under /data.
FROM rust:1-slim AS cli
# perl and make: a dependency builds OpenSSL from source, and the slim image has only perl-base.
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev perl make \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY sdk/near ./sdk/near
RUN cargo build --release --locked --manifest-path sdk/near/Cargo.toml

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY sentinels ./sentinels
RUN pip install --no-cache-dir ./sentinels
COPY --from=cli /src/sdk/near/target/release/styx-near-vault /usr/local/bin/styx-near-vault
RUN useradd --create-home styx && mkdir -p /data && chown styx /data
USER styx
ENV STYX_SENTINEL_SERVICE_ROOT=/data/sentinels-service PYTHONUNBUFFERED=1
EXPOSE 8795
CMD ["styx-sentinels", "serve", "--host", "0.0.0.0", "--port", "8795", "--allow-origin", "https://styxco.xyz"]
