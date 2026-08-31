# ジョブカン シフト取得 セットアップ手順

ジョブカン勤怠の勤務シフトを自動で取得し、このアプリのデータベースへ取り込みます。
毎月 14 日と 30 日に GitHub Actions が無人で実行します。

```
GitHub Actions ──> ジョブカン（ブラウザ操作で取得）
                        │
                        └──> POST /api/staff/import-schedules ──> staff_schedules
```

## 1. ジョブカン側で確認すること

### 店舗（グループ）ID

シフト表のページを開くと、URL に `group_id` が入っています。

```
https://ssl.jobcan.jp/client/shift-schedule/?group_id=3&tab_type=shift_schedule
                                                       ↑ これ
```

既定では次の 3 店舗を取得します。変える場合は後述の `JOBCAN_GROUPS` で指定します。

| group_id | 店舗名 |
|---|---|
| 3 | 萩野通店 |
| 5 | 笠寺店 |
| 6 | 枇杷島店 |

### 取得に使うアカウント

管理者ページ（`/employee/login-manager/`）に入れるアカウントが必要です。
シフト表を閲覧できる権限があれば足ります。

## 2. アプリ側の設定

### 取り込み口の合言葉

スクレイパーは GitHub Actions から来るので、ログインセッションを持ちません。
代わりに合言葉で認証します。**未設定だと取り込みは 503 で拒否されます**
（設定漏れのまま誰でも書き込める状態になるより、動かない方が安全なため）。

```bash
flyctl secrets set IMPORT_SECRET=$(openssl rand -base64 32)
```

同じ値を GitHub のシークレットにも登録します（次の手順）。

### 店舗と拠点の対応付け

取り込んだシフトを、このアプリのどの拠点のものとして扱うかを決めます。
判定は次の順です。

1. `locations.jobcan_group_id` が group_id と一致する拠点
2. 見つからなければ、拠点名がジョブカンの店舗名と一致する拠点
3. どちらでもなければ拠点なしで保存（シフト自体は失われません）

**拠点名がジョブカンの店舗名と同じなら、設定は要りません。** 2 の名前一致で結びつきます。

名前が違う場合は `jobcan_group_id` を設定してください。

```bash
flyctl ssh console
sqlite3 /data/main.db "UPDATE locations SET jobcan_group_id = '3' WHERE location_name = '萩野通店';"
```

対応付かない店舗があると、実行ログに次の警告が出ます。

```
⚠ 拠点に結びつかない店舗: 萩野通店
  locations.jobcan_group_id を設定してください
```

## 3. GitHub の設定

**Settings → Secrets and variables → Actions** で登録します。

### Secrets（秘密の値）

| Name | 値 |
|---|---|
| `JOBCAN_EMAIL` | ジョブカンのログイン用メールアドレス |
| `JOBCAN_PASSWORD` | ジョブカンのパスワード |
| `API_BASE` | 取り込み先（例 `https://inventory-system-aburiva.fly.dev`） |
| `IMPORT_SECRET` | 手順 2 で Fly に設定したのと同じ値 |

### Variables（秘密でない値・任意）

| Name | 値 |
|---|---|
| `JOBCAN_GROUPS` | 店舗を変える場合のみ。`[{"id":"3","name":"萩野通店"}]` の形の JSON |

未設定なら既定の 3 店舗を取得します。

## 4. 動作確認

### 手元で 1 店舗だけ試す

`.env` に `JOBCAN_EMAIL` / `JOBCAN_PASSWORD` を書いてから実行します。
`--dry-run` を付けると**取得だけして保存しません**。

```bash
# 1 店舗・1 ヶ月だけ、保存せずに取得する
JOBCAN_GROUPS='[{"id":"3","name":"萩野通店"}]' \
  node scripts/scrape-jobcan.js 2026-09 --dry-run
```

件数と中身（スタッフ名 / 日付 / 時刻）が正しいか確認してください。
取得結果は `debug/schedules-2026-09.json` にも保存されます。

**この JSON は手元で実行したときだけ作られます。** 中身は勤務予定そのもの
（氏名と勤務時間）で伏せようがないため、GitHub Actions では書き出しません。
同じ理由で、GitHub Actions の実行ログにはスタッフ名を出しません。
公開リポジトリでは実行ログもアーティファクトも誰でも読めるためです。

### 保存まで通す

```bash
API_BASE=https://... IMPORT_SECRET=... \
  node scripts/scrape-jobcan.js 2026-09
```

保存されたかは、管理者でログインして次の API で確認できます。

```
GET /api/staff/schedules?month=2026-09
```

### GitHub Actions から手動で実行する

Actions タブ →「ジョブカン シフト取得」→「Run workflow」。
対象月と「取得だけ」の指定ができます。

## 5. 壊れたときの直し方

**一番壊れやすいのはシフト表の解析です。** ジョブカンの HTML 構造が変われば
セレクタが合わなくなり、エラーではなく「0 件」という形で失敗します。

実行のたびに `debug/` へ HTML を保存しています。
GitHub Actions の場合は、実行の Artifacts からダウンロードできます。

**この HTML は中身の文字を伏せてあります。** このリポジトリは公開されていて、
GitHub Actions のアーティファクトは誰でもダウンロードできるため、スタッフの
氏名や勤務時間をそのまま置いておけません。数字は `0`、それ以外の文字は `●` に
置き換えたうえで保存します。

```
山田 太郎  ->  ●● ●●
19:00      ->  00:00
```

タグ・`class`・`id` はそのまま残るので、セレクタを直すのに支障はありません。
スクリーンショットは撮りません。画像は同じやり方で伏せられないためです。

直す場所は `scripts/scrape-jobcan.js` の `extractSchedules()` です。
現在の前提は次のとおりです。

| 対象 | セレクタ |
|---|---|
| シフト表 | `table.note` |
| 日付ヘッダー | `th.day` |
| スタッフ名 | `th.first[colspan="2"]` |
| 各日のセル | `td.day` / `td.applying.day` |
| 時刻 | セル内の `span[style*="font-size: 10px"]` を `<br>` で分割 |

この前提は `test-jobcan.js` が固定しています。セレクタを直したら
テストの HTML も実際の構造に合わせて更新してください。

```bash
node test-jobcan.js
```

### よくある失敗

| 症状 | 原因 |
|---|---|
| `ログインできませんでした` | メールアドレスかパスワードが違う |
| `1 件も取得できませんでした` | HTML 構造が変わった。`debug/` を確認 |
| `「表示」ボタンが見つかりません` | 同上。`.btn-info` が変わった可能性 |
| `IMPORT_SECRET が設定されていないため…` | アプリ側に `IMPORT_SECRET` が未設定 |
| `認証に失敗しました` | GitHub 側と Fly 側で `IMPORT_SECRET` が食い違っている |

## 保存されるデータ

| テーブル | 内容 |
|---|---|
| `staff` | スタッフ（名前で一意）。ジョブカンに新しい名前が出たら自動で追加されます |
| `staff_schedules` | 勤務予定。`(staff_id, date, start_time)` で一意 |

同じ日・同じ開始時刻の予定は 1 件に保ちます。終了時刻が変わったときは
行を増やさず上書きするので、**何度実行しても重複しません**。

`staff` はこのアプリのログインアカウント（`users`）とは別物です。
ジョブカンに載る勤務者が対象で、アプリにログインするとは限りません。
