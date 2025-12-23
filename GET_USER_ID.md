# LINE ユーザーID / グループID の取得方法

## 最も簡単な方法：個人アカウントに通知を送る

グループIDの取得が難しい場合、まずは個人アカウントに通知を送ることができます。

### 手順

1. **Botを友だち追加**
   - LINE Developersコンソールの QRコード から友だち追加

2. **Botに「ユーザーID」と送信**
   - 1対1のトークで「ユーザーID」とメッセージを送信
   - ※ この機能は後で実装します

3. **または、簡易Webhookサーバーを起動**

## 簡易Webhookサーバーを使う方法（推奨）

ローカルでngrokを使ってWebhookを有効化します：

### 1. ngrokのインストール（まだの場合）

```bash
# Homebrewの場合
brew install ngrok

# または公式サイトからダウンロード
# https://ngrok.com/download
```

### 2. ngrokで公開

```bash
# 別のターミナルで実行
ngrok http 3000
```

出力される `Forwarding` の URL をコピー：
```
Forwarding   https://xxxx-xx-xx-xxx-xxx.ngrok-free.app -> http://localhost:3000
```

### 3. LINE Developers で Webhook URL を設定

1. LINE Developersコンソール → チャネル設定
2. Messaging API設定タブ
3. Webhook URL: `https://xxxx-xx-xx-xxx-xxx.ngrok-free.app/api/line/webhook`
4. Webhookの利用: **オン**
5. 検証ボタンをクリックして確認

### 4. グループでメッセージを送信

1. Botが参加しているグループで何かメッセージを送信
2. サーバーのログを確認：

```
==========================================
📍 LINEグループID: Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
このIDを .env ファイルに設定してください:
LINE_NOTIFICATION_GROUP_ID=Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
==========================================
```

3. 表示されたグループIDをコピー

### 5. グループIDを設定

```bash
node setup-group-id.js
```

上記のコマンドを実行し、コピーしたグループIDを入力。

---

## 代替方法：LINE公式アカウントのチャット画面から

残念ながら、LINE公式アカウントの管理画面URL（`https://chat.line.biz/...`）に含まれるIDは、
Messaging APIで使用するグループIDとは**異なる形式**です。

### なぜ違うのか

- 管理画面のID: チャットルームを識別するID（内部管理用）
- Messaging API のグループID: API経由でメッセージを送信する際に使うID

これらは別の識別子なので、Messaging APIで通知を送るには、
Webhookまたはその他の方法でグループIDを取得する必要があります。

---

## まとめ

**最も簡単な順序：**

1. ✅ **ngrok + Webhook** （推奨、5分で完了）
2. 個人アカウントに通知（グループではなく個人に送る）
3. Webhookサーバーを本番環境に設置

どの方法を試しますか？
