FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY db ./db
ENV NODE_ENV=production
USER node
CMD ["node", "src/server.js"]
