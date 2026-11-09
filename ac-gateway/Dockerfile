ARG BUILD_FROM
FROM ${BUILD_FROM}
RUN apk add --no-cache nodejs
COPY gateway.mjs /gateway.mjs
CMD ["node", "/gateway.mjs"]
