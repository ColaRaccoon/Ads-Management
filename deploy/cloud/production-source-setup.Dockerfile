# syntax=docker/dockerfile:1.7
FROM ghcr.io/colaraccoon/meta-ads-performance-c7@sha256:e3fb7eedf91ef64d6c26590856d2c979e5644b644109d4fb9549ad8ad66fa964 AS c7
FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS build
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --workspace @meta-ads-performance/api --workspace @meta-ads-performance/shared --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY apps/api/prisma/schema.prisma apps/api/prisma/schema.prisma
RUN node node_modules/prisma/build/index.js generate --schema apps/api/prisma/schema.prisma
COPY apps/api/src apps/api/src
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
RUN node node_modules/typescript/bin/tsc -p apps/api/tsconfig.build.json
COPY --from=c7 /srv/app/apps/api/dist /baseline
COPY deploy/cloud/verify-source-setup-patch.mjs /verify-source-setup-patch.mjs
RUN node /verify-source-setup-patch.mjs /baseline /build/apps/api/dist

FROM c7
ARG RAILWAY_GIT_COMMIT_SHA
RUN node -e 'if(!/^[a-f0-9]{40}$/.test(process.argv[1])) throw Error("Release commit required")' "${RAILWAY_GIT_COMMIT_SHA}"
ENV IMAGE_RELEASE_GIT_SHA=${RAILWAY_GIT_COMMIT_SHA}
ENV RELEASE_GIT_SHA=${RAILWAY_GIT_COMMIT_SHA}
LABEL org.opencontainers.image.revision=${RAILWAY_GIT_COMMIT_SHA}
COPY --from=build --chown=node:node /build/apps/api/dist /srv/app/apps/api/dist
COPY --chown=node:node deploy/cloud/production-source-launch.mjs /srv/app/deploy/cloud/production-source-launch.mjs
CMD ["node", "deploy/cloud/production-source-launch.mjs"]
