const line = require('@line/bot-sdk');

// LINE Messaging API クライアントの設定
const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    channelSecret: process.env.LINE_CHANNEL_SECRET || ''
};

let client = null;

/**
 * LINE への通知を、プログラムの中で止めている（店の判断で、いったん送らない）。
 *
 * true の間は、NOTIFICATIONS_ENABLED を入れても一切送らない。自動発注のお知らせも、
 * シフト未確認・未登録の人の通知もで、未確認の見張り自体も動かない。
 * 設定の入れ間違いで鳴り出すことがないよう、設定ではなくプログラムで止めている。
 *
 * 送るように戻すとき: これを false にしてデプロイし、
 *   flyctl secrets set NOTIFICATIONS_ENABLED=true
 */
const LINE_NOTIFICATIONS_STOPPED = true;

/**
 * NOTIFICATIONS_ENABLED のスイッチが入っているか（プログラムで止めているかは見ない）。
 *
 * 既定は「送らない」。止めるからには理由があって止めているので、
 * 環境変数を明示的に立てたときだけ送る形にしている。設定を消し忘れた
 * だけで鳴り出す、ということが起きない。
 *
 * 呼ばれるたびに読む。起動時に固めると、テストから切り替えられない。
 */
function notificationSwitchOn() {
    const value = String(process.env.NOTIFICATIONS_ENABLED ?? '').trim().toLowerCase();
    return value === 'true' || value === '1' || value === 'on';
}

/**
 * 通知を送ってよいか。プログラムで止めている間は、スイッチに関係なく送らない。
 */
function notificationsEnabled() {
    return !LINE_NOTIFICATIONS_STOPPED && notificationSwitchOn();
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

if (LINE_NOTIFICATIONS_STOPPED) {
    console.log(
        'LINE への通知はプログラムで止めてあります（NOTIFICATIONS_ENABLED に関係なく送りません）。' +
        '送るように戻すには server/services/line-notify.js の LINE_NOTIFICATIONS_STOPPED を false にしてください。'
    );
} else if (!notificationSwitchOn()) {
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

/**
 * 2 人以上で入っている区切りで、締め切りまでに確認していない人を知らせる。
 *
 * 区切り全体の「確認がまだです」ではなく、誰がまだかを名前で出す。
 * 確認は、自分の名前で出庫を登録するか、「出していない」を押すこと。
 */
async function sendShiftMemberReminder(groupId, shiftInfo) {
    // 送信の出口。ここで止めれば通知は一切出ない
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
            text: `⏰ 在庫の登録がまだの人がいます\n\n` +
                  `店舗: ${shiftInfo.locationName}\n` +
                  `区切り: ${shiftInfo.shiftName}（${shiftInfo.endTime}）\n` +
                  `未登録: ${shiftInfo.names.join('・')}\n\n` +
                  `出した物があれば自分の名前で登録を、\n` +
                  `出していなければ自分の「出していない」を押してください。`
        };

        await client.pushMessage({
            to: groupId,
            messages: [message]
        });

        console.log(`区切りの未登録の通知を送信しました: ${shiftInfo.locationName} - ${shiftInfo.shiftName}`);
        return true;
    } catch (error) {
        console.error('区切りの未登録の通知の送信エラー:', error);
        return false;
    }
}

module.exports = {
    sendOrderNotification,
    sendShiftReminder,
    sendShiftMemberReminder,
    LINE_NOTIFICATIONS_STOPPED,
    notificationSwitchOn,
    notificationsEnabled,
    isEnabled: () => !!client && notificationsEnabled()
};
