FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY . .
RUN node download-dictionary.js
EXPOSE 3000
CMD ["node", "server.js"]
