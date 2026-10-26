# syntax=docker/dockerfile:1.7
# Preserve the reviewed operating-system/runtime baseline and rebuild both apps.
FROM ghcr.io/colaraccoon/meta-ads-performance-c7@sha256:e3fb7eedf91ef64d6c26590856d2c979e5644b644109d4fb9549ad8ad66fa964 AS c7
FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS build
WORKDIR /build
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --workspace @meta-ads-performance/api --workspace @meta-ads-performance/web --workspace @meta-ads-performance/shared --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY apps/api/prisma/schema.prisma apps/api/prisma/schema.prisma
RUN node node_modules/prisma/build/index.js generate --schema apps/api/prisma/schema.prisma
COPY apps/api/src apps/api/src
COPY apps/api/scripts apps/api/scripts
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
RUN node node_modules/typescript/bin/tsc -p apps/api/tsconfig.build.json
COPY --from=c7 /srv/app/apps/api/dist /baseline
COPY deploy/cloud/verify-source-setup-patch.mjs /verify-source-setup-patch.mjs
RUN node /verify-source-setup-patch.mjs /baseline /build/apps/api/dist reporting
COPY apps/web/src apps/web/src
COPY apps/web/next.config.mjs apps/web/next-env.d.ts apps/web/tsconfig.json apps/web/
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_API_BASE_URL=/backend-api NEXT_PUBLIC_AUTH_PROVIDER=supabase HSTS_ENABLED=true
RUN npm run build
RUN npm prune --omit=dev --legacy-peer-deps --workspace @meta-ads-performance/api --workspace @meta-ads-performance/web --workspace @meta-ads-performance/shared --include-workspace-root \
  && rm -rf node_modules/@playwright node_modules/playwright node_modules/playwright-core node_modules/@meta-ads-performance/e2e \
  && rm -f node_modules/.bin/playwright \
  && rm -rf node_modules/@aws-sdk node_modules/@smithy \
  && find apps/web/.next/standalone -type f -name '*.map' -delete

FROM c7
ARG RAILWAY_GIT_COMMIT_SHA
RUN node -e 'if(!/^[a-f0-9]{40}$/.test(process.argv[1])) throw Error("Release commit required")' "${RAILWAY_GIT_COMMIT_SHA}"
ENV IMAGE_RELEASE_GIT_SHA=${RAILWAY_GIT_COMMIT_SHA}
ENV RELEASE_GIT_SHA=${RAILWAY_GIT_COMMIT_SHA}
LABEL org.opencontainers.image.revision=${RAILWAY_GIT_COMMIT_SHA}
USER root
# Remove stale modules and Next output before installing this exact lockfile build.
RUN rm -rf /srv/app/node_modules /srv/app/apps/web /srv/app/apps/api/dist
COPY --from=build --chown=node:node /build/node_modules /srv/app/node_modules
COPY --from=build --chown=node:node /build/apps/api/dist /srv/app/apps/api/dist
COPY --from=build --chown=node:node /build/apps/web/.next/standalone /srv/app/
COPY --from=build --chown=node:node /build/apps/web/.next/static /srv/app/apps/web/.next/static
COPY --chown=node:node deploy/cloud/production-source-launch.mjs /srv/app/deploy/cloud/production-source-launch.mjs
COPY deploy/cloud/assert-runtime-closure.mjs /assert-runtime-closure.mjs
RUN node /assert-runtime-closure.mjs /srv/app && rm /assert-runtime-closure.mjs
USER node
CMD ["node", "deploy/cloud/production-source-launch.mjs"]
