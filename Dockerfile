FROM node:20-alpine

WORKDIR /app

# Встановлюємо залежності
COPY package*.json ./
RUN npm ci --omit=dev

# Копіюємо код
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Старт серверу
CMD ["node", "index.js"]
