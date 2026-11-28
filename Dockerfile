FROM node:20-slim
WORKDIR /app
COPY . .
RUN chmod +x /app/xray || true
ENV NODE_ENV=production
CMD ["node", "index.js"]
