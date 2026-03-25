FROM node:18-slim

# Instalar dependências para o Puppeteer (mesmo usando remoto, ajuda na estabilidade)
RUN apt-get update && apt-get install -y \
    libnss3 \
    libatk-bridge2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
VOLUME ["/app/.wwebjs_auth"]
COPY package*.json ./
RUN npm install
COPY . .

CMD ["npm", "start"]
