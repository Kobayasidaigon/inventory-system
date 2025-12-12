# ベースイメージ
FROM node:18-alpine

# sharp のビルドに必要な依存関係をインストール
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    vips-dev

# 作業ディレクトリを設定
WORKDIR /app

# package.jsonとpackage-lock.jsonをコピー
COPY package*.json ./

# 依存関係をインストール
RUN npm ci --only=production

# アプリケーションのソースコードをコピー
COPY . .

# データベース用のディレクトリを作成
RUN mkdir -p /data

# ポート3000を公開
EXPOSE 3000

# 環境変数を設定
ENV NODE_ENV=production
ENV PORT=3000

# アプリケーションを起動
CMD ["node", "server/app.js"]
