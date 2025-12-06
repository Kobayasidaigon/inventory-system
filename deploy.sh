#!/bin/bash

# Azure App Service デプロイスクリプト

echo "Starting deployment..."

# Node.jsの依存関係をインストール
echo "Installing dependencies..."
npm install --production

echo "Deployment completed successfully!"
