FROM node:20-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.mjs ./
ENV AUTH_DIR=/data/auth
EXPOSE 3000
CMD ["node", "index.mjs"]
