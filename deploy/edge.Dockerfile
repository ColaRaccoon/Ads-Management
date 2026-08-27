ARG NODE_IMAGE=node:22.18.0-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /srv/edge
COPY --chown=node:node deploy/maintenance-edge.mjs ./maintenance-edge.mjs
RUN mkdir -p /run/maintenance && touch /run/maintenance/.keep && chown -R node:node /run/maintenance
USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
CMD ["node", "maintenance-edge.mjs"]
