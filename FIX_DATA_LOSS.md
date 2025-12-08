# Fly.io データ消失問題の解決手順

## 問題
デプロイ後2-3分でデータが消えてしまう

## 原因
データベースファイルがコンテナの一時ストレージに保存されており、永続ボリュームに保存されていない

## 解決手順

### 1. 環境変数の設定

以下のコマンドを実行して、データベースとアップロードファイルの保存先を永続ボリュームに設定します：

```bash
flyctl secrets set DB_DIR=/data
flyctl secrets set UPLOADS_DIR=/data/uploads
flyctl secrets set SESSION_SECRET=$(openssl rand -base64 32)
```

### 2. 設定の確認

環境変数が正しく設定されているか確認：

```bash
flyctl secrets list
```

以下が表示されるはずです：
- `DB_DIR`
- `UPLOADS_DIR`
- `SESSION_SECRET`

### 3. アプリケーションを再デプロイ

```bash
flyctl deploy
```

### 4. 動作確認

デプロイ完了後、以下を確認：

```bash
# ログを確認
flyctl logs

# SSHで接続してデータを確認
flyctl ssh console
ls -la /data
```

`/data`ディレクトリに以下のファイルが作成されているはずです：
- `main.db`
- `location_*.db`
- `uploads/` ディレクトリ

## 既に作成済みのボリュームがあるか確認

```bash
flyctl volumes list
```

もしボリュームが作成されていない場合：

```bash
flyctl volumes create inventory_data --region nrt --size 1
```

## 完了

これでデータがコンテナの再起動後も保持されるようになります。

## 参考

詳しい手順は [DEPLOY.md](./DEPLOY.md) を参照してください。
