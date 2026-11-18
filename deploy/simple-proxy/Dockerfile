FROM node:20-alpine
WORKDIR /app
COPY server.mjs package.json ./
ENV PORT=8081
EXPOSE 8081
CMD ["node", "server.mjs"]
