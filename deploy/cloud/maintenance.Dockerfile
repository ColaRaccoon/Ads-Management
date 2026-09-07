# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE

FROM ${NODE_IMAGE} AS dependencies
ARG NODE_IMAGE
WORKDIR /srv/app
RUN node -e "if (!/@sha256:[a-f0-9]{64}$/.test(process.env.NODE_IMAGE ?? '')) throw new Error('NODE_IMAGE must be pinned by sha256 digest')"
# Keep maintenance build tooling on the same exact security fix as the public runtime.
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates openssl libpcre2-8-0=10.42-1+deb12u1 \
  && dpkg-query --show --showformat='${Version}\n' libpcre2-8-0 | grep -Fx '10.42-1+deb12u1' \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global npm@10.9.4 && npm --version | grep -Fx 10.9.4
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/e2e/package.json apps/e2e/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,target=/root/.npm npm ci \
  --workspace @meta-ads-performance/api \
  --workspace @meta-ads-performance/shared \
  --include-workspace-root

FROM dependencies AS build
ARG RELEASE_GIT_SHA
COPY . .
RUN node deploy/cloud/assert-build-context-clean.mjs
RUN node -e "if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(process.env.RELEASE_GIT_SHA ?? '')) throw new Error('RELEASE_GIT_SHA must be a full commit id')"
RUN npm run prisma:generate
RUN ./node_modules/.bin/tsc -p apps/api/maintenance/tsconfig.json
RUN npm run build -w apps/api

FROM build AS production-dependencies
RUN npm prune --omit=dev --legacy-peer-deps \
  --workspace @meta-ads-performance/api \
  --workspace @meta-ads-performance/shared \
  --include-workspace-root \
  && rm -rf node_modules/@playwright node_modules/playwright node_modules/playwright-core node_modules/@meta-ads-performance/e2e \
  && rm -f node_modules/.bin/playwright

FROM production-dependencies AS runtime-dependencies
RUN rm -rf node_modules/@aws-sdk node_modules/@smithy

FROM runtime-dependencies AS migration-dependencies
RUN --mount=type=cache,target=/root/.npm \
  npm install --omit=dev --legacy-peer-deps --no-save --package-lock=false prisma@6.12.0 \
  && rm -rf node_modules/@playwright node_modules/playwright node_modules/playwright-core node_modules/@meta-ads-performance/e2e \
  && rm -rf node_modules/@aws-sdk node_modules/@smithy \
  && rm -f node_modules/.bin/playwright \
  && node -e "if (require('./node_modules/prisma/package.json').version !== '6.12.0') throw new Error('Prisma CLI version mismatch')"

FROM ${NODE_IMAGE} AS maintenance-base
ARG NODE_IMAGE
ARG RELEASE_GIT_SHA
WORKDIR /srv/maintenance
RUN node -e "if (!/@sha256:[a-f0-9]{64}$/.test(process.env.NODE_IMAGE ?? '')) throw new Error('NODE_IMAGE must be pinned by sha256 digest')" \
  && node -e "if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(process.env.RELEASE_GIT_SHA ?? '')) throw new Error('RELEASE_GIT_SHA must be a full commit id')"
# All five purpose images inherit this fail-closed package pin and version check.
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates openssl libpcre2-8-0=10.42-1+deb12u1 \
  && dpkg-query --show --showformat='${Version}\n' libpcre2-8-0 | grep -Fx '10.42-1+deb12u1' \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
LABEL org.opencontainers.image.revision=${RELEASE_GIT_SHA}
COPY --chown=node:node deploy/cloud/maintenance-entrypoint.mjs ./maintenance-entrypoint.mjs
COPY --chown=node:node deploy/cloud/assert-maintenance-artifact.mjs ./assert-maintenance-artifact.mjs
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/srv/maintenance/maintenance-entrypoint.mjs"]

FROM maintenance-base AS auth
ARG RELEASE_GIT_SHA
ENV MAINTENANCE_PURPOSE=auth
LABEL org.opencontainers.image.revision=${RELEASE_GIT_SHA} io.meta-ads.maintenance.purpose=auth
COPY --from=runtime-dependencies --chown=node:node /srv/app/node_modules ./node_modules
COPY --from=build --chown=node:node /srv/app/apps/api/dist-maintenance/shared ./dist/shared
COPY --from=build --chown=node:node /srv/app/apps/api/dist-maintenance/auth ./dist/auth
COPY --from=build --chown=node:node /srv/app/apps/api/dist/auth/bootstrap-super-admin.js ./dist/runtime-auth/bootstrap-super-admin.js
COPY --from=build --chown=node:node /srv/app/apps/api/dist/auth/email-normalizer.js ./dist/runtime-auth/email-normalizer.js
RUN printf 'auth\n' > ./purpose && node ./assert-maintenance-artifact.mjs /srv/maintenance auth
USER node
CMD ["user-disposition"]

FROM maintenance-base AS migration
ARG RELEASE_GIT_SHA
ENV MAINTENANCE_PURPOSE=migration
LABEL org.opencontainers.image.revision=${RELEASE_GIT_SHA} io.meta-ads.maintenance.purpose=migration
COPY --from=migration-dependencies --chown=node:node /srv/app/node_modules ./node_modules
COPY --from=build --chown=node:node /srv/app/apps/api/dist-maintenance/shared ./dist/shared
COPY --from=build --chown=node:node /srv/app/apps/api/dist-maintenance/migration ./dist/migration
COPY --from=build --chown=node:node /srv/app/apps/api/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=build --chown=node:node /srv/app/apps/api/prisma/migrations ./prisma/migrations
RUN install -d -m 0700 -o node -g node /run/maintenance-output/migration \
  && printf 'migration\n' > ./purpose \
  && node ./assert-maintenance-artifact.mjs /srv/maintenance migration
USER node
CMD ["migrate-deploy"]

FROM maintenance-base AS storage
ARG RELEASE_GIT_SHA
ENV MAINTENANCE_PURPOSE=storage
LABEL org.opencontainers.image.revision=${RELEASE_GIT_SHA} io.meta-ads.maintenance.purpose=storage
COPY --from=runtime-dependencies --chown=node:node /srv/app/node_modules ./node_modules
COPY --from=build --chown=node:node /srv/app/apps/api/dist-maintenance/shared ./dist/shared
COPY --from=build --chown=node:node /srv/app/apps/api/dist-maintenance/storage ./dist/storage
COPY --from=build --chown=node:node /srv/app/apps/api/maintenance/storage/sql/storage-policy.sql ./sql/storage-policy.sql
RUN printf 'storage\n' > ./purpose && node ./assert-maintenance-artifact.mjs /srv/maintenance storage
USER node
CMD ["policy"]

FROM maintenance-base AS backup
ARG RELEASE_GIT_SHA
ENV MAINTENANCE_PURPOSE=backup
LABEL org.opencontainers.image.revision=${RELEASE_GIT_SHA} io.meta-ads.maintenance.purpose=backup
COPY --from=production-dependencies --chown=node:node /srv/app/node_modules ./node_modules
COPY --from=build --chown=node:node /srv/app/apps/api/dist-maintenance/shared ./dist/shared
COPY --from=build --chown=node:node /srv/app/apps/api/dist-maintenance/backup ./dist/backup
# Bookworm's generic client is PostgreSQL 15. Use the official signed PGDG 17 client
# and matching libpq; the numeric component prevents a silent libpq 18 upgrade.
ADD --checksum=sha256:0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76 --chmod=0644 https://www.postgresql.org/media/keys/ACCC4CF8.asc /usr/share/keyrings/postgresql-pgdg.asc
RUN set -eu; architecture="$(dpkg --print-architecture)"; \
  case "$architecture" in amd64|arm64|ppc64el) ;; *) printf '%s\n' 'Unsupported PGDG Bookworm architecture' >&2; exit 1 ;; esac; \
  printf '%s\n' 'Types: deb' 'URIs: https://apt.postgresql.org/pub/repos/apt' \
    'Suites: bookworm-pgdg' "Architectures: $architecture" 'Components: main 17' \
    'Signed-By: /usr/share/keyrings/postgresql-pgdg.asc' > /etc/apt/sources.list.d/pgdg.sources; \
  apt-get update && apt-get install --yes --no-install-recommends postgresql-client-17=17.11-1.pgdg12+2 \
    libpq5=17.11-1.pgdg12+2 postgresql-client-common=293.pgdg12+1 util-linux \
  && dpkg-query --show --showformat='${Version}\n' postgresql-client-17 | grep -Fx '17.11-1.pgdg12+2' \
  && dpkg-query --show --showformat='${Version}\n' libpq5 | grep -Fx '17.11-1.pgdg12+2' \
  && rm -f /etc/apt/sources.list.d/pgdg.sources \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -m 0700 -o node -g node /run/maintenance-output/backup \
  && test -x /usr/bin/pg_dump \
  && test -x /usr/bin/prlimit \
  && node -e "const s=require('@aws-sdk/client-s3'); if (!s.S3Client || !s.HeadObjectCommand || !s.PutObjectCommand || !s.GetObjectCommand) throw new Error('Backup S3 runtime closure invalid')" \
  && node -e "const p=require('@prisma/client'); if (!p.PrismaClient) throw new Error('Backup Prisma runtime closure invalid')" \
  && printf 'backup\n' > ./purpose \
  && node ./assert-maintenance-artifact.mjs /srv/maintenance backup
USER node
CMD ["backup"]

FROM maintenance-base AS legacy
ARG RELEASE_GIT_SHA
ENV MAINTENANCE_PURPOSE=legacy
LABEL org.opencontainers.image.revision=${RELEASE_GIT_SHA} io.meta-ads.maintenance.purpose=legacy
COPY --from=runtime-dependencies --chown=node:node /srv/app/node_modules ./node_modules
COPY --from=build --chown=node:node /srv/app/apps/api/dist-maintenance/shared ./dist/shared
COPY --from=build --chown=node:node /srv/app/apps/api/dist-maintenance/legacy ./dist/legacy
COPY --from=build --chown=node:node /srv/app/apps/api/maintenance/legacy/contracts ./contracts/legacy
RUN install -d -m 0700 -o node -g node /run/maintenance-output/legacy \
  && node -e "const p=require('@prisma/client'); if (!p.PrismaClient || !p.Prisma?.sql) throw new Error('Legacy Prisma runtime closure invalid')" \
  && printf 'legacy\n' > ./purpose \
  && node ./assert-maintenance-artifact.mjs /srv/maintenance legacy
USER node
CMD ["inventory"]
