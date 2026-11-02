# A private, finite cron process. No HTTP listener, provider credentials or web session keys.
FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS build
WORKDIR /srv/app
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --workspace @meta-ads-performance/api --workspace @meta-ads-performance/shared --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY apps/api/prisma/schema.prisma apps/api/prisma/schema.prisma
RUN node node_modules/prisma/build/index.js generate --schema apps/api/prisma/schema.prisma
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api/src apps/api/src
COPY apps/api/scripts apps/api/scripts
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
RUN npm --workspace @meta-ads-performance/shared run build && npm --workspace @meta-ads-performance/api run build
RUN npm prune --omit=dev --legacy-peer-deps --workspace @meta-ads-performance/api --workspace @meta-ads-performance/shared --include-workspace-root

FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /srv/app
ARG RAILWAY_GIT_COMMIT_SHA
ENV NODE_ENV=production IMAGE_RELEASE_GIT_SHA=${RAILWAY_GIT_COMMIT_SHA}
COPY --from=build --chown=node:node /srv/app/node_modules ./node_modules
COPY --from=build --chown=node:node /srv/app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /srv/app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /srv/app/packages/shared ./packages/shared
COPY --chown=node:node deploy/cloud/certs/supabase-prod-ca-2021.crt ./deploy/cloud/certs/supabase-prod-ca-2021.crt
USER node
CMD ["node", "apps/api/dist/unified-performance/reconciliation-entrypoint.js"]
