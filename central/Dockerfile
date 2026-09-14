FROM node:22-alpine AS build
WORKDIR /app/central
COPY central/package*.json ./
RUN npm ci
COPY central ./
COPY shared ../shared
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY central/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/central/dist ./dist
COPY central/migrations ./migrations
USER node
EXPOSE 8787
CMD ["node", "dist/central/src/index.js"]
