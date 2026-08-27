# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22.18.0-bookworm-slim

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /srv/app
RUN npm install --global npm@10.9.4 && npm --version | grep -Fx 10.9.4
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,target=/root/.npm npm ci

FROM dependencies AS build
COPY . .
ENV NODE_ENV=production
ENV API_PROXY_TARGET=http://127.0.0.1:4200/api
RUN npm run prisma:generate && npm run build
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
WORKDIR /srv/app
ENV NODE_ENV=production
ENV PORT=3200
ENV API_INTERNAL_PORT=4200
ENV HOSTNAME=0.0.0.0
ENV API_PROXY_TARGET=http://127.0.0.1:4200/api
COPY --from=build --chown=node:node /srv/app/node_modules ./node_modules
COPY --from=build --chown=node:node /srv/app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /srv/app/apps/api/prisma ./apps/api/prisma
COPY --from=build --chown=node:node /srv/app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /srv/app/apps/web/.next/static ./apps/web/.next/static
COPY --chown=node:node deploy/launch-bundle.mjs ./deploy/launch-bundle.mjs
USER node
EXPOSE 3200
STOPSIGNAL SIGTERM
CMD ["node", "deploy/launch-bundle.mjs"]
