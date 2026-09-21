FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src ./src
COPY data/catalog.sqlite ./data/catalog.sqlite
EXPOSE 8787
ENV PORT=8787
CMD ["node", "--import", "tsx", "server/index.ts"]
