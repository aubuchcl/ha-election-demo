FROM node:22-alpine

WORKDIR /app

# Zero dependencies — Node standard library only.
COPY app.js .

CMD ["node", "app.js"]
