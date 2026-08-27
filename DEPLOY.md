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

## GitHub Actions で自動デプロイする

`main` に入ったら自動でデプロイされます。手動で流したいときは
GitHub の Actions タブ →「Fly.io へデプロイ」→「Run workflow」からも実行できます。

デプロイの前に `npm test` が走り、**失敗したらデプロイは行われません。**

### 1. Fly.io のデプロイ用トークンを作る

```bash
flyctl tokens create deploy -x 999999h
```

出力された `FlyV1 ...` の文字列全体をコピーします。
（個人アカウント全体の権限ではなく、このアプリのデプロイに限定されたトークンです）

### 2. GitHub にトークンを登録する

リポジトリの **Settings → Secrets and variables → Actions →
New repository secret** で登録します。

| 項目 | 値 |
|---|---|
| Name | `FLY_API_TOKEN` |
| Secret | 手順 1 でコピーした `FlyV1 ...` |

名前は `FLY_API_TOKEN` にしてください。ワークフローがこの名前で参照します。

### 3. 初回デプロイの前に確認すること

一度きりですが、これを飛ばすと運用に影響します。

**① セッションの署名鍵を設定する（必須）**

```bash
flyctl secrets set SESSION_SECRET=$(openssl rand -base64 32)
```

未設定でも起動はしますが、再起動のたびに鍵が変わります。

**② バックアップを取る**

起動時にデータベースの構成を更新します（列とテーブルの追加）。
追加だけなので既存データは壊れませんが、念のため。

```bash
flyctl ssh console -C "tar czf /tmp/backup.tar.gz /data"
flyctl ssh sftp get /tmp/backup.tar.gz
```

**③ 費用の確認**

`fly.toml` の `min_machines_running` が `1` になっています。
定期処理（通知・バックアップ）を動かすため常時 1 台起動する設定です。
不要なら `0` に戻してください。

### デプロイ後に起きること

- **利用者はログインし直す必要はありません。** セッションの鍵が変わるので
  既存のセッションは無効になりますが、Remember Me トークンから自動で復帰します
- 「ログイン状態を保持」を外していた人だけ、1 回ログインが必要です

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


