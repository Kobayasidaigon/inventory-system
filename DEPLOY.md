# Fly.ioデプロイ手順書

## 前提条件

- Fly.ioアカウント（無料で作成可能）
- flyctlコマンドラインツールのインストール

## 1. Fly.ioのセットアップ

### flyctlのインストール

```bash
# Linux/WSL
curl -L https://fly.io/install.sh | sh

# Mac
brew install flyctl

# Windows (PowerShell)
iwr https://fly.io/install.ps1 -useb | iex
```

### Fly.ioにログイン

```bash
flyctl auth login
```

ブラウザが開き、Fly.ioにログインします。

## 2. アプリケーションの作成

プロジェクトディレクトリで以下を実行：

```bash
cd /home/kurohana2929/douga/inventory-system
flyctl launch
```

質問に対する回答：
- **App Name**: `inventory-system`（または任意の名前）
- **Region**: `nrt` (Tokyo)
- **PostgreSQL**: `No`（SQLiteを使用）
- **Redis**: `No`

## 3. ボリュームの作成（データ永続化）

SQLiteデータベースを永続化するためのボリュームを作成：

```bash
flyctl volumes create inventory_data --region nrt --size 1
```

## 4. 環境変数の設定

マルチテナントモードを有効にする場合：

```bash
flyctl secrets set MULTI_TENANT=true
flyctl secrets set DB_DIR=/data
flyctl secrets set SESSION_SECRET=your-random-secret-key-here
```

シングルテナント（既存の動作）の場合：

```bash
flyctl secrets set MULTI_TENANT=false
flyctl secrets set SESSION_SECRET=your-random-secret-key-here
```

## 5. デプロイ

```bash
flyctl deploy
```

## 6. デプロイの確認

```bash
# アプリケーションの状態を確認
flyctl status

# ログを確認
flyctl logs

# ブラウザで開く
flyctl open
```

## 7. 初期ユーザーの設定

### シングルテナントモード
デフォルトユーザー: `admin` / `admin123`

### マルチテナントモード
アプリケーションにアクセスして新規ユーザー登録を行います。

## マルチテナント機能について

### 概要
- ユーザーごとに独立したデータベースを持つ
- ユーザーAとユーザーBは異なるデータを管理できる
- データは完全に分離される

### 有効化方法
1. 環境変数 `MULTI_TENANT=true` を設定
2. アプリケーションを再起動

### 新規ユーザー登録
マルチテナントモードでは、ログイン画面から新規ユーザーを登録できます。
各ユーザーには専用のデータベースが自動的に作成されます。

## トラブルシューティング

### ログの確認
```bash
flyctl logs --app inventory-system
```

### SSHでコンテナに接続
```bash
flyctl ssh console
```

### ボリュームの確認
```bash
flyctl volumes list
```

### アプリケーションの再起動
```bash
flyctl apps restart inventory-system
```

## スケーリング

### 無料プラン（推奨設定）
```bash
flyctl scale count 1 --max-per-region 1
flyctl scale memory 256
```

### より多くのリソースが必要な場合
```bash
flyctl scale count 2
flyctl scale memory 512
```

## データベースバックアップ

### 手動バックアップ
```bash
# SSHで接続
flyctl ssh console

# データベースをコピー
cd /data
tar -czf backup-$(date +%Y%m%d).tar.gz *.db

# ローカルにダウンロード
flyctl ssh sftp get /data/backup-*.tar.gz
```

## カスタムドメインの設定

```bash
flyctl certs add yourdomain.com
```

その後、DNSに以下を追加：
- Type: CNAME
- Name: @（または www）
- Value: inventory-system.fly.dev

## コスト管理

### 無料枠の内容
- 最小インスタンス3台まで無料
- 256MB RAM × 3 = 768MB まで無料
- ボリューム 3GB まで無料

### コスト確認
```bash
flyctl billing show
```

## 更新方法

コードを変更した後：

```bash
git add .
git commit -m "Update application"
flyctl deploy
```

## 本番環境での推奨設定

1. **セッションシークレットの変更**
   ```bash
   flyctl secrets set SESSION_SECRET=$(openssl rand -base64 32)
   ```

2. **自動デプロイの設定**
   GitHub Actionsを使用した自動デプロイを設定可能

3. **モニタリング**
   Fly.ioのダッシュボードでメトリクスを確認

## 関連リンク

- [Fly.io Documentation](https://fly.io/docs/)
- [Fly.io Pricing](https://fly.io/docs/about/pricing/)
- [Fly.io Dashboard](https://fly.io/dashboard)


