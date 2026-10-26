FROM node:22.23.4-alpine
WORKDIR /app
COPY server.js icon.svg apple-touch-icon.png ./
USER node
EXPOSE 18790
CMD ["node", "server.js"]
