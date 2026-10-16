# The image runs server.mjs. Set MASSIVE_API_KEY in the host's environment.
FROM node:22-alpine
WORKDIR /app
COPY index.html music.js universe.json server.mjs package.json ./
COPY lib ./lib
COPY docs ./docs
ENV PORT=8811
EXPOSE 8811
CMD ["node", "server.mjs"]
