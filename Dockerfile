# NexTool MCP for GLPI: stdio server built from this repository (mcp-glpi-core, then mcp-glpi).
# Used by directories that run the server to inspect it (e.g. Glama). No credentials are baked in:
# without GLPI_* variables the server still starts and answers initialize and tools/list; pass
# GLPI_URL / GLPI_USER_TOKEN / GLPI_APP_TOKEN (and GLPI_V2_* for the API v2 tools) at run time.
#   docker build -t nextool-mcp-glpi .
#   docker run -i --rm -e GLPI_URL=https://glpi.example.com -e GLPI_USER_TOKEN=... nextool-mcp-glpi
FROM node:22-alpine AS build
WORKDIR /app
COPY mcp-glpi-core/package.json mcp-glpi-core/package-lock.json mcp-glpi-core/
COPY mcp-glpi/package.json mcp-glpi/package-lock.json mcp-glpi/
# the server's lockfile links ../mcp-glpi-core, so both installs run side by side
RUN cd mcp-glpi-core && npm ci && cd ../mcp-glpi && npm ci
COPY mcp-glpi-core/tsconfig.json mcp-glpi-core/
COPY mcp-glpi-core/src mcp-glpi-core/src
RUN cd mcp-glpi-core && npm run build
COPY mcp-glpi/tsconfig.json mcp-glpi/
COPY mcp-glpi/src mcp-glpi/src
RUN cd mcp-glpi && npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/mcp-glpi-core/package.json mcp-glpi-core/
COPY --from=build /app/mcp-glpi-core/dist mcp-glpi-core/dist
COPY --from=build /app/mcp-glpi/package.json mcp-glpi/
COPY --from=build /app/mcp-glpi/dist mcp-glpi/dist
COPY --from=build /app/mcp-glpi/node_modules mcp-glpi/node_modules
USER node
CMD ["node", "mcp-glpi/dist/index.js"]
