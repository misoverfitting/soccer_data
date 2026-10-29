FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY app ./app
COPY data/matches.json ./data/matches.json
COPY data/matches ./data/matches
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "app/server.mjs"]
