ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base:3.21
FROM ${BUILD_FROM}
RUN apk add --no-cache nodejs
COPY gateway.mjs /gateway.mjs
CMD ["node", "/gateway.mjs"]
