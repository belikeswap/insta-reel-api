FROM --platform=linux/x86_64 node:18-slim

RUN apt update
RUN apt install libgconf-2-4 libatk1.0-0 libatk-bridge2.0-0 libgdk-pixbuf2.0-0 libgtk-3-0 libgbm-dev libnss3-dev libxss-dev libasound2 -y

WORKDIR /app

COPY package-lock.json .
COPY package.json .
COPY pnpm-lock.yaml .
COPY pnpm-workspace.yaml .

RUN npm install -g pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

RUN pnpm ci

COPY . .

EXPOSE 8080

CMD ["pnpm", "start"]

