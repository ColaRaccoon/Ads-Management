# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS build
ARG NODE_IMAGE
WORKDIR /srv/app
RUN node -e "if (!/@sha256:[a-f0-9]{64}$/.test(process.env.NODE_IMAGE ?? '')) throw new Error('NODE_IMAGE must be pinned')"
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --workspace @meta-ads-performance/api --workspace @meta-ads-performance/shared --include-workspace-root
COPY tsconfig.base.json ./
COPY apps/api/tsconfig.json apps/api/tsconfig.cafe24-test.json apps/api/
COPY apps/api/prisma/cafe24-test.schema.prisma apps/api/prisma/cafe24-test.schema.prisma
COPY apps/api/prisma/schema.prisma apps/api/prisma/schema.prisma
COPY apps/api/src apps/api/src
RUN ./node_modules/.bin/prisma generate --schema apps/api/prisma/schema.prisma \
  && ./node_modules/.bin/tsc -p apps/api/tsconfig.cafe24-test.json
RUN node -e "const f=require('fs');const p='apps/api/dist-cafe24';const walk=d=>f.readdirSync(d,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(d+'/'+x.name):[d+'/'+x.name]);const files=walk(p);if(files.some(x=>/(?:^|\/)meta-|\/(?:metrics|mappings)\/|\/(?:google-|google_)/i.test(x)))throw Error('Unrelated code in Cafe24 artifact');if(!files.some(x=>x.endsWith('cafe24-railway-test.js'))||!files.some(x=>x.endsWith('cafe24-live-canonical.cli.js')))throw Error('Cafe24 entry missing')"
RUN npm prune --omit=dev --legacy-peer-deps --workspace @meta-ads-performance/api --workspace @meta-ads-performance/shared --include-workspace-root

FROM ${NODE_IMAGE} AS runtime
WORKDIR /srv/app
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build --chown=node:node /srv/app/node_modules ./node_modules
COPY --from=build --chown=node:node /srv/app/apps/api/dist-cafe24 ./apps/api/dist-cafe24
COPY --chown=node:node deploy/cafe24-test/init.sql ./deploy/cafe24-test/init.sql
COPY --chown=node:node deploy/cafe24-test/live-additive.sql ./deploy/cafe24-test/live-additive.sql
USER node
EXPOSE 8000
STOPSIGNAL SIGTERM
CMD ["node", "apps/api/dist-cafe24/daily-sync/cafe24-railway-test.js"]
