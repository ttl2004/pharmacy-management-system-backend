# Backend NestJS (Fastify + Prisma).
# Giữ đủ devDependencies và src/ trong image để chạy được prisma migrate và các script seed (ts-node).
# Biến môi trường không nằm trong image: docker compose đọc từ .env của repo này (env_file).
FROM node:22-bookworm-slim

# Prisma engine cần openssl.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

# Ảnh sản phẩm / tờ HDSD lưu ở /app/uploads (gắn volume trong compose).
RUN mkdir -p /app/uploads

ENV PORT=3790
EXPOSE 3790

# Áp migration còn thiếu rồi mới chạy app.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
