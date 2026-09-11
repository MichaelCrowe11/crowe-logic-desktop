# The build context is the repository root, not this directory.
#
# That is not an accident to tidy up later. control-plane/service.js requires
# ../cloud/contract.js directly, because the usage id has to be derived by the
# exact same code on the client and the server or idempotency quietly stops
# working. Copying a duplicate of that file into the image would make the
# divergence possible again, so the image contains the original, at the same
# relative path it has in the repository.
#
#   docker build -f control-plane/Dockerfile -t crowe-control-plane .

FROM node:22-alpine AS deps
WORKDIR /app/control-plane
COPY control-plane/package.json control-plane/package-lock.json* ./
# Production only, and --ignore-scripts because nothing here needs a postinstall
# and an image that runs arbitrary install scripts is an image with a supply
# chain inside it.
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/control-plane/node_modules ./control-plane/node_modules
COPY control-plane/ ./control-plane/
COPY cloud/contract.js ./cloud/contract.js

# The node image already ships an unprivileged `node` user. Using it means a
# container escape starts from a normal account rather than from root.
RUN chown -R node:node /app
USER node
WORKDIR /app/control-plane

EXPOSE 8080
ENV PORT=8080

# Readiness, which checks the database, rather than liveness, which does not.
# A replica that cannot reach Postgres should leave rotation, not be restarted,
# because restarting it does not fix Postgres and does discard warm connections.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
