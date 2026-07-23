# CSB application image: contract toolchain + demo server.
# Used by docker-compose.demo.yml for the chain/deployer/demo services, and
# standalone as the demo server against any RPC:
#
#   docker build -t csb-app .
#   docker run -p 8080:8080 -e CSB_RPC_URL=... -e EXPLORER_PASSCODE=... csb-app
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY hardhat.config.js ./
COPY contracts ./contracts
COPY scripts ./scripts
COPY test ./test
COPY chain ./chain
COPY demo ./demo

# Compiles offline: hardhat.config.js falls back to the npm-installed solc-js.
RUN npx hardhat compile

EXPOSE 8080
CMD ["node", "demo/server.js"]
