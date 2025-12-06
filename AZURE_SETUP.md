# Azure環境へのデプロイ手順

## 前提条件
- Azureアカウント
- Azure CLI のインストール

## 手順

### 1. Azure CLIでログイン
```bash
az login
```

### 2. Azure SQL Databaseの作成

#### 2.1 リソースグループの作成
```bash
az group create --name inventory-rg --location japaneast
```

#### 2.2 SQL Serverの作成
```bash
az sql server create \
  --name inventory-sql-server-zaiko \
  --resource-group inventory-rg \
  --location japaneast \
  --admin-user sqladmin \
  --admin-password MiwaMiwa
```

#### 2.3 ファイアウォールルールの作成（Azure内部からの接続を許可）
```bash
az sql server firewall-rule create \
  --resource-group inventory-rg \
  --server inventory-sql-server-<ユニーク名> \
  --name AllowAzureServices \
  --start-ip-address 0.0.0.0 \
  --end-ip-address 0.0.0.0
```

#### 2.4 無料データベースの作成
```bash
az sql db create \
  --resource-group inventory-rg \
  --server inventory-sql-server-zaiko \
  --name inventory-db \
  --edition GeneralPurpose \
  --compute-model Serverless \
  --family Gen5 \
  --capacity 1 \
  --auto-pause-delay 60 \
  --min-capacity 0.5
```

**注意**: 無料プランを適用するには、Azureポータルで設定を確認してください。

#### 2.5 データベーススキーマの適用

Azure Data StudioまたはSQL Server Management Studioを使用して、`server/db/azure-sql-schema.sql`を実行します。

または、Azure CLIで:
```bash
az sql db show-connection-string \
  --client sqlcmd \
  --name inventory-db \
  --server inventory-sql-server-<ユニーク名>

# 接続文字列をコピーして、sqlcmdでスキーマを実行
sqlcmd -S inventory-sql-server-<ユニーク名>.database.windows.net \
  -d inventory-db \
  -U sqladmin \
  -P <パスワード> \
  -i server/db/azure-sql-schema.sql
```

### 3. Azure App Serviceの作成

#### 3.1 App Service Planの作成（無料プラン）
```bash
az appservice plan create \
  --name inventory-plan \
  --resource-group inventory-rg \
  --sku F1 \
  --is-linux
```

**注意**: F1は無料プランです。本番環境では有料プランの利用を推奨します。

#### 3.2 Web Appの作成
```bash
az webapp create \
  --resource-group inventory-rg \
  --plan inventory-plan \
  --name inventory-app-<ユニーク名> \
  --runtime "NODE|18-lts"
```

#### 3.3 環境変数の設定
```bash
az webapp config appsettings set \
  --resource-group inventory-rg \
  --name inventory-app-<ユニーク名> \
  --settings \
    USE_AZURE_SQL="true" \
    AZURE_SQL_SERVER="inventory-sql-server-<ユニーク名>.database.windows.net" \
    AZURE_SQL_DATABASE="inventory-db" \
    AZURE_SQL_USER="sqladmin" \
    AZURE_SQL_PASSWORD="<パスワード>" \
    SESSION_SECRET="your-secret-key-change-this" \
    WEBSITE_NODE_DEFAULT_VERSION="18-lts"
```

### 4. アプリケーションのデプロイ

#### オプション1: Azure CLI経由でデプロイ
```bash
# プロジェクトのルートディレクトリで実行
zip -r deploy.zip . -x "node_modules/*" -x ".git/*" -x "*.db"

az webapp deployment source config-zip \
  --resource-group inventory-rg \
  --name inventory-app-<ユニーク名> \
  --src deploy.zip
```

#### オプション2: GitHubからのデプロイ
```bash
# GitHubリポジトリを作成してコードをプッシュ後:
az webapp deployment source config \
  --name inventory-app-<ユニーク名> \
  --resource-group inventory-rg \
  --repo-url https://github.com/<your-username>/<your-repo> \
  --branch main \
  --manual-integration
```

### 5. アプリケーションへのアクセス
```bash
az webapp browse \
  --name inventory-app-<ユニーク名> \
  --resource-group inventory-rg
```

または、ブラウザで以下にアクセス:
```
https://inventory-app-<ユニーク名>.azurewebsites.net
```

デフォルトログイン情報:
- ユーザー名: `admin`
- パスワード: `admin123`

## トラブルシューティング

### ログの確認
```bash
az webapp log tail \
  --name inventory-app-<ユニーク名> \
  --resource-group inventory-rg
```

### データベース接続テスト
```bash
az sql db show-connection-string \
  --client ado.net \
  --name inventory-db \
  --server inventory-sql-server-<ユニーク名>
```

### 環境変数の確認
```bash
az webapp config appsettings list \
  --name inventory-app-<ユニーク名> \
  --resource-group inventory-rg
```

## コスト管理

### 無料プランの制限
- **Azure SQL Database (Free Offer)**:
  - 100,000 仮想コア秒/月
  - 32GB ストレージ
  - 自動一時停止機能あり

- **App Service (F1 Free)**:
  - 1GB ディスク容量
  - 60分/日の実行時間
  - カスタムドメインなし
  - 常時稼働なし

### コスト監視
```bash
az consumption usage list \
  --resource-group inventory-rg
```

## セキュリティ強化

### 1. セッションシークレットの変更
必ず`SESSION_SECRET`環境変数を強力なランダム文字列に変更してください。

### 2. SQLパスワードの管理
Azure Key Vaultの利用を推奨:
```bash
az keyvault create \
  --name inventory-keyvault-<ユニーク名> \
  --resource-group inventory-rg \
  --location japaneast

az keyvault secret set \
  --vault-name inventory-keyvault-<ユニーク名> \
  --name sql-password \
  --value "<パスワード>"
```

### 3. HTTPSの強制
```bash
az webapp update \
  --resource-group inventory-rg \
  --name inventory-app-<ユニーク名> \
  --https-only true
```

## 更新とメンテナンス

### アプリケーションの更新
```bash
# コード変更後、再デプロイ
zip -r deploy.zip . -x "node_modules/*" -x ".git/*" -x "*.db"

az webapp deployment source config-zip \
  --resource-group inventory-rg \
  --name inventory-app-<ユニーク名> \
  --src deploy.zip
```

### データベースバックアップ
Azure SQL Databaseは自動バックアップされますが、手動バックアップも可能:
```bash
az sql db export \
  --resource-group inventory-rg \
  --server inventory-sql-server-<ユニーク名> \
  --name inventory-db \
  --admin-user sqladmin \
  --admin-password <パスワード> \
  --storage-key-type StorageAccessKey \
  --storage-key <ストレージキー> \
  --storage-uri https://<ストレージアカウント>.blob.core.windows.net/backups/inventory.bacpac
```

## ローカル開発環境でのテスト

### SQLiteモードで実行（デフォルト）
```bash
npm start
```

### Azure SQLモードで実行
```bash
# .envファイルを作成
cp .env.example .env

# .envファイルを編集してAzure SQL接続情報を設定
USE_AZURE_SQL=true
AZURE_SQL_SERVER=inventory-sql-server-<ユニーク名>.database.windows.net
AZURE_SQL_DATABASE=inventory-db
AZURE_SQL_USER=sqladmin
AZURE_SQL_PASSWORD=<パスワード>

# アプリケーション起動
npm start
```

## 参考リンク
- [Azure SQL Database 無料プラン](https://learn.microsoft.com/ja-jp/azure/azure-sql/database/free-offer)
- [Azure App Service 料金](https://azure.microsoft.com/ja-jp/pricing/details/app-service/windows/)
- [Node.js on Azure App Service](https://learn.microsoft.com/ja-jp/azure/app-service/quickstart-nodejs)
