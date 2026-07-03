# Runner imajı — SANDBOX=docker modunda kullanıcı kodunun derlenip
# çalıştırıldığı minimal, root olmayan imaj.
#   docker build -t cpp-pratik-runner backend/runner
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ libstdc++-12-dev \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 --shell /usr/sbin/nologin runner

USER runner
WORKDIR /box
