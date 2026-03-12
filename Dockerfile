FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY server.js index.html portfolio.json ./
# Create history.json if it doesn't exist
RUN test -f history.json || echo "[]" > history.json

EXPOSE 3457

CMD ["node", "server.js"]
