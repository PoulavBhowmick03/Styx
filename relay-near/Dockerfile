FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8788
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 8788
CMD ["node", "dist/main.cjs"]
