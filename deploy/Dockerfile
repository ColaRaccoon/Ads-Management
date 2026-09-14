# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE

FROM ${NODE_IMAGE} AS dependencies
ARG NODE_IMAGE
WORKDIR /srv/app
RUN node -e "if (!/@sha256:[a-f0-9]{64}$/.test(process.env.NODE_IMAGE ?? '')) throw new Error('NODE_IMAGE must be pinned by sha256 digest')"
# Pin the Bookworm PCRE2 security update; fail if the exact package is unavailable.
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates openssl libpcre2-8-0=10.42-1+deb12u1 \
  && dpkg-query --show --showformat='${Version}\n' libpcre2-8-0 | grep -Fx '10.42-1+deb12u1' \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global npm@10.9.4 && npm --version | grep -Fx 10.9.4
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/e2e/package.json apps/e2e/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci \
  --workspace @meta-ads-performance/api \
  --workspace @meta-ads-performance/web \
  --workspace @meta-ads-performance/shared \
  --include-workspace-root

FROM dependencies AS build
ARG RELEASE_GIT_SHA
COPY . .
RUN node deploy/cloud/assert-build-context-clean.mjs
ENV NODE_ENV=production
ENV APP_ENV=production
ENV DEPLOYMENT_MODE=cloud_container
ENV AUTH_PROVIDER=supabase
ENV STORAGE_PROVIDER=supabase
ENV IMAGE_RELEASE_GIT_SHA=${RELEASE_GIT_SHA}
ENV RELEASE_GIT_SHA=${RELEASE_GIT_SHA}
ENV API_PROXY_TARGET=http://127.0.0.1:4200/api
ENV API_INTERNAL_PORT=4200
ENV NEXT_PUBLIC_API_BASE_URL=/backend-api
ENV NEXT_PUBLIC_AUTH_PROVIDER=supabase
ENV HSTS_ENABLED=true
RUN node -e "if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(process.env.RELEASE_GIT_SHA ?? '')) throw new Error('RELEASE_GIT_SHA build argument must be a full SHA-1 or SHA-256 commit id')"
RUN npm run prisma:generate && npm run build
RUN npm prune --omit=dev --legacy-peer-deps \
  --workspace @meta-ads-performance/api \
  --workspace @meta-ads-performance/web \
  --workspace @meta-ads-performance/shared \
  --include-workspace-root \
  && rm -rf node_modules/@playwright node_modules/playwright node_modules/playwright-core node_modules/@meta-ads-performance/e2e \
  && rm -rf node_modules/@aws-sdk node_modules/@smithy \
  && rm -f node_modules/.bin/playwright
RUN find apps/web/.next/standalone -type f -name '*.map' -delete

FROM ${NODE_IMAGE} AS runtime
ARG RELEASE_GIT_SHA
WORKDIR /srv/app
# Keep the runtime on the same exact Bookworm security update as the build stages.
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates openssl libpcre2-8-0=10.42-1+deb12u1 \
  && dpkg-query --show --showformat='${Version}\n' libpcre2-8-0 | grep -Fx '10.42-1+deb12u1' \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY deploy/cloud/certs/supabase-prod-ca-2021.crt /usr/local/share/ca-certificates/supabase-prod-ca-2021.crt
RUN update-ca-certificates
ENV APP_ENV=production
ENV DEPLOYMENT_MODE=cloud_container
ENV AUTH_PROVIDER=supabase
ENV STORAGE_PROVIDER=supabase
ENV PORT=8000
ENV API_INTERNAL_PORT=4200
ENV API_PROXY_TARGET=http://127.0.0.1:4200/api
ENV API_NODE_MAX_OLD_SPACE_MB=512
ENV WEB_NODE_MAX_OLD_SPACE_MB=192
ENV BUNDLE_SHUTDOWN_GRACE_MS=10000
ENV IMAGE_RELEASE_GIT_SHA=${RELEASE_GIT_SHA}
ENV RELEASE_GIT_SHA=${RELEASE_GIT_SHA}
LABEL org.opencontainers.image.revision=${RELEASE_GIT_SHA}
COPY --from=build --chown=node:node /srv/app/node_modules ./node_modules
COPY --from=build --chown=node:node /srv/app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /srv/app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /srv/app/apps/web/.next/static ./apps/web/.next/static
COPY --chown=node:node deploy/launch-bundle.mjs ./deploy/launch-bundle.mjs
COPY --chown=node:node deploy/cloud/ready-barrier.mjs ./deploy/cloud/ready-barrier.mjs
COPY --chown=node:node deploy/cloud/assert-runtime-closure.mjs ./deploy/cloud/assert-runtime-closure.mjs
RUN node deploy/cloud/assert-runtime-closure.mjs /srv/app \
  && rm -f deploy/cloud/assert-runtime-closure.mjs
USER node
EXPOSE 8000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/backend-api/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "deploy/launch-bundle.mjs"]
