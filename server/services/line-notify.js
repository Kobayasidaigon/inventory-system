const line = require('@line/bot-sdk');

// LINE Messaging API クライアントの設定
const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    channelSecret: process.env.LINE_CHANNEL_SECRET || ''
};

let client = null;

/**
 * 通知を送ってよいか。
 *
 * 既定は「送らない」。止めるからには理由があって止めているので、
 * 環境変数を明示的に立てたときだけ送る形にしている。設定を消し忘れた
 * だけで鳴り出す、ということが起きない。
 *
 * 送るように戻すとき:
 *   flyctl secrets set NOTIFICATIONS_ENABLED=true
 *
 * 呼ばれるたびに読む。起動時に固めると、テストから切り替えられない。
 */
function notificationsEnabled() {
    const value = String(process.env.NOTIFICATIONS_ENABLED ?? '').trim().toLowerCase();
    return value === 'true' || value === '1' || value === 'on';
}

// クライアントの初期化
function initLineClient() {
    if (!config.channelAccessToken || !config.channelSecret) {
        console.warn('LINE Messaging API の設定がありません。LINE通知は無効です。');
        return false;
    }

    try {
        client = new line.messagingApi.MessagingApiClient(config);
        console.log('LINE Messaging API クライアントを初期化しました');
        return true;
    } catch (error) {
        console.error('LINE クライアントの初期化エラー:', error);
        return false;
    }
}

// 初期化
initLineClient();

if (!notificationsEnabled()) {
    console.log(
        '通知は止めてあります（NOTIFICATIONS_ENABLED が未設定）。' +
        '送るように戻すには NOTIFICATIONS_ENABLED=true を設定してください。'
    );
}

/**
 * グループに発注通知メッセージを送信
 * @param {string} groupId - LINEグループID
 * @param {object} orderInfo - 発注情報
 * @returns {Promise<boolean>} 送信成功/失敗
 */
async function sendOrderNotification(groupId, orderInfo) {
    // 送信の唯一の出口なので、ここで止めれば通知は一切出ない
    if (!notificationsEnabled()) {
        return false;
    }

    if (!client) {
        console.log('LINE クライアントが初期化されていません');
        return false;
    }

    if (!groupId) {
        console.log('グループIDが設定されていません');
        return false;
    }

    try {
        const message = {
            type: 'text',
            text: `📦 発注依頼通知\n\n` +
                  `店舗: ${orderInfo.locationName}\n` +
                  `商品: ${orderInfo.productName}\n` +
                  `現在庫: ${orderInfo.currentStock}\n` +
                  `発注点: ${orderInfo.reorderPoint}\n\n` +
                  `⚠️ 在庫が発注点を下回りました。`
        };

        await client.pushMessage({
            to: groupId,
            messages: [message]
        });

        console.log(`LINE通知を送信しました: ${orderInfo.locationName} - ${orderInfo.productName}`);
        return true;
    } catch (error) {
        console.error('LINE通知の送信エラー:', error);
        return false;
    }
}

/**
 * シフトの区切りが未確認のまま過ぎたことを知らせる
 * @param {string} groupId - LINEグループID
 * @param {object} shiftInfo - シフト情報
 * @returns {Promise<boolean>} 送信成功/失敗
 */
async function sendShiftReminder(groupId, shiftInfo) {
    // 送信の唯一の出口なので、ここで止めれば通知は一切出ない
    if (!notificationsEnabled()) {
        return false;
    }

    if (!client) {
        console.log('LINE クライアントが初期化されていません');
        return false;
    }

    if (!groupId) {
        console.log('グループIDが設定されていません');
        return false;
    }

    try {
        const message = {
            type: 'text',
            text: `⏰ 在庫の確認がまだです\n\n` +
                  `店舗: ${shiftInfo.locationName}\n` +
                  `区切り: ${shiftInfo.shiftName}（${shiftInfo.endTime}）\n\n` +
                  `在庫が減っていれば登録を、動きがなければ\n` +
                  `「在庫の変化なし」を押してください。`
        };

        await client.pushMessage({
            to: groupId,
            messages: [message]
        });

        console.log(`シフト確認の通知を送信しました: ${shiftInfo.locationName} - ${shiftInfo.shiftName}`);
        return true;
    } catch (error) {
        console.error('シフト確認通知の送信エラー:', error);
        return false;
    }
}

module.exports = {
    sendOrderNotification,
    sendShiftReminder,
    notificationsEnabled,
    isEnabled: () => !!client && notificationsEnabled()
};
