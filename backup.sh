#!/bin/bash

# Fly.io inventory-system バックアップスクリプト
# 使い方: ./backup.sh

APP_NAME="inventory-system-aburiva"
BACKUP_DIR="./backups"
DATE=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="backup-${DATE}.tar.gz"

# バックアップディレクトリを作成
mkdir -p ${BACKUP_DIR}

echo "バックアップを開始します..."
echo "アプリ名: ${APP_NAME}"
echo "日時: ${DATE}"

# SSHでコンテナに接続してバックアップを作成
echo "リモートでバックアップファイルを作成中..."
flyctl ssh console -a ${APP_NAME} -C "cd /data && tar -czf ${BACKUP_FILE} *.db uploads/ 2>/dev/null || tar -czf ${BACKUP_FILE} *.db"

# バックアップファイルをダウンロード
echo "バックアップファイルをダウンロード中..."
flyctl ssh sftp get /data/${BACKUP_FILE} ${BACKUP_DIR}/ -a ${APP_NAME}

# リモートのバックアップファイルを削除
echo "リモートの一時ファイルを削除中..."
flyctl ssh console -a ${APP_NAME} -C "rm /data/${BACKUP_FILE}"

echo "バックアップが完了しました: ${BACKUP_DIR}/${BACKUP_FILE}"

# 30日以上古いバックアップを削除
echo "古いバックアップファイルを削除中..."
find ${BACKUP_DIR} -name "backup-*.tar.gz" -mtime +30 -delete

echo "完了！"
