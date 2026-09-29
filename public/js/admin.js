let selectedLocationId = null;

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
    await checkAdminAuth();
    await loadLocations();
    await loadAllInventoryAndOrders();
    initTabs();
});

// タブ切り替え機能
function initTabs() {
    const tabButtons = document.querySelectorAll('.admin-tab');

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetTab = button.getAttribute('data-tab');

            // すべてのタブボタンとコンテンツから active クラスを削除
            tabButtons.forEach(btn => btn.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });

            // クリックされたタブボタンとコンテンツに active クラスを追加
            button.classList.add('active');
            document.getElementById(targetTab).classList.add('active');
        });
    });
}

// 管理者認証チェック
async function checkAdminAuth() {
    try {
        const response = await fetch('/api/auth/check');
        const data = await response.json();

        if (!data.loggedIn || !data.isAdmin) {
            window.location.href = '/';
            return;
        }

        document.getElementById('admin-name').textContent = `管理者: ${data.userName}`;
    } catch (error) {
        console.error('認証チェックエラー:', error);
        window.location.href = '/';
    }
}

// ログアウト
document.getElementById('logout-btn').addEventListener('click', async () => {
    try {
        await fetchWithCsrf('/api/auth/logout', { method: 'POST' });
        window.location.href = '/';
    } catch (error) {
        console.error('ログアウトエラー:', error);
    }
});

// 拠点一覧読み込み
async function loadLocations() {
    try {
        const response = await fetch('/api/auth/admin/locations');
        const locations = await response.json();

        const locationList = document.getElementById('location-list');
        locationList.innerHTML = '';

        if (locations.length === 0) {
            locationList.innerHTML = '<p style="color: #666;">登録されている拠点がありません</p>';
            return;
        }

        locations.forEach(location => {
            const div = document.createElement('div');
            div.className = 'location-item';
            div.innerHTML = `
                <div class="location-info">
                    <strong>${location.location_name}</strong>
                    <span style="color: #666; margin-left: 10px;">(${location.location_code})</span>
                    <div style="font-size: 12px; color: #999; margin-top: 5px;">
                        登録日: ${new Date(location.created_at).toLocaleDateString('ja-JP')}
                    </div>
                </div>
                <div class="action-buttons">
                    <button class="btn-small btn-edit">編集</button>
                    <button class="btn-small btn-delete">削除</button>
                </div>
            `;

            // イベントリスナーを追加
            const locationInfo = div.querySelector('.location-info');
            const editBtn = div.querySelector('.btn-edit');
            const deleteBtn = div.querySelector('.btn-delete');

            locationInfo.addEventListener('click', () => {
                selectLocation(location.id, location.location_name, location.location_code);
            });

            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                editLocation(location.id, location.location_name);
            });

            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteLocation(location.id, location.location_name);
            });

            locationList.appendChild(div);
        });
    } catch (error) {
        console.error('拠点読み込みエラー:', error);
        alert('拠点の読み込みに失敗しました');
    }
}

// 拠点選択
async function selectLocation(locationId, locationName, locationCode) {
    selectedLocationId = locationId;

    // 選択状態の表示更新
    document.querySelectorAll('.location-item').forEach(item => {
        item.classList.remove('selected');
    });
    event.target.closest('.location-item').classList.add('selected');

    // 選択された拠点情報を表示
    document.getElementById('selected-location-info').textContent =
        `選択中: ${locationName} (${locationCode})`;

    // ユーザーフォームとテーブルを表示
    document.getElementById('user-form').style.display = 'flex';
    document.getElementById('users-table').style.display = 'table';

    // ユーザー一覧を読み込み
    await loadUsers(locationId);
}

// ユーザー一覧読み込み
async function loadUsers(locationId) {
    try {
        const response = await fetch(`/api/auth/admin/locations/${locationId}/users`);
        const users = await response.json();

        const usersList = document.getElementById('users-list');
        usersList.innerHTML = '';

        if (users.length === 0) {
            usersList.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #666;">登録されているユーザーがいません</td></tr>';
            return;
        }

        users.forEach(user => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${user.id}</td>
                <td>${user.user_id}</td>
                <td>${user.user_name}</td>
                <td>${new Date(user.created_at).toLocaleDateString('ja-JP')}</td>
                <td>
                    <button class="btn btn-small btn-edit" data-user-id="${user.id}" data-user-login-id="${user.user_id}" data-user-name="${user.user_name}">編集</button>
                    <button class="btn btn-small btn-delete" data-user-id="${user.id}" data-user-login-id="${user.user_id}">削除</button>
                </td>
            `;

            // イベントリスナーを追加
            const editBtn = tr.querySelector('.btn-edit');
            const deleteBtn = tr.querySelector('.btn-delete');

            editBtn.addEventListener('click', () => {
                showEditUserModal(user.id, user.user_id, user.user_name);
            });

            deleteBtn.addEventListener('click', () => {
                deleteUser(user.id, user.user_id);
            });

            usersList.appendChild(tr);
        });
    } catch (error) {
        console.error('ユーザー読み込みエラー:', error);
        alert('ユーザーの読み込みに失敗しました');
    }
}

// 拠点追加
document.getElementById('add-location-btn').addEventListener('click', async () => {
    const locationName = document.getElementById('location-name').value.trim();

    if (!locationName) {
        alert('拠点名を入力してください');
        return;
    }

    try {
        const response = await fetchWithCsrf('/api/auth/admin/locations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locationName })
        });

        const data = await response.json();

        if (response.ok) {
            alert('拠点を追加しました');
            document.getElementById('location-name').value = '';
            await loadLocations();
            await loadViewLocationSelect();
        } else {
            alert(data.error || '拠点の追加に失敗しました');
        }
    } catch (error) {
        console.error('拠点追加エラー:', error);
        alert('拠点の追加に失敗しました');
    }
});

// ユーザー追加
document.getElementById('add-user-btn').addEventListener('click', async () => {
    if (!selectedLocationId) {
        alert('拠点を選択してください');
        return;
    }

    const userId = document.getElementById('user-id').value.trim();
    const userName = document.getElementById('user-name').value.trim();
    const password = document.getElementById('user-password').value;

    if (!userId || !userName || !password) {
        alert('すべての項目を入力してください');
        return;
    }

    try {
        const response = await fetchWithCsrf('/api/auth/admin/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                locationId: selectedLocationId,
                userId,
                userName,
                password
            })
        });

        const data = await response.json();

        if (response.ok) {
            alert('ユーザーを追加しました');
            document.getElementById('user-id').value = '';
            document.getElementById('user-name').value = '';
            document.getElementById('user-password').value = '';
            await loadUsers(selectedLocationId);
        } else {
            alert(data.error || 'ユーザーの追加に失敗しました');
        }
    } catch (error) {
        console.error('ユーザー追加エラー:', error);
        alert('ユーザーの追加に失敗しました');
    }
});

// 拠点編集
async function editLocation(locationId, currentName) {
    const newName = prompt('新しい拠点名を入力してください:', currentName);

    if (!newName || newName === currentName) {
        return;
    }

    try {
        const response = await fetchWithCsrf(`/api/auth/admin/locations/${locationId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locationName: newName })
        });

        const data = await response.json();

        if (response.ok) {
            alert('拠点を更新しました');
            await loadLocations();
        } else {
            alert(data.error || '拠点の更新に失敗しました');
        }
    } catch (error) {
        console.error('拠点編集エラー:', error);
        alert('拠点の更新に失敗しました');
    }
}

// 拠点削除
async function deleteLocation(locationId, locationName) {
    if (!confirm(`拠点「${locationName}」を削除してもよろしいですか？\n\n※この拠点に登録されているユーザーがいる場合は削除できません。`)) {
        return;
    }

    try {
        const response = await fetchWithCsrf(`/api/auth/admin/locations/${locationId}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (response.ok) {
            alert('拠点を削除しました');

            // 削除した拠点が選択中の場合、選択をクリア
            if (selectedLocationId === locationId) {
                selectedLocationId = null;
                document.getElementById('selected-location-info').textContent = '※ 左側の拠点リストから拠点を選択してください';
                document.getElementById('user-form').style.display = 'none';
                document.getElementById('users-table').style.display = 'none';
            }

            await loadLocations();
        } else {
            alert(data.error || '拠点の削除に失敗しました');
        }
    } catch (error) {
        console.error('拠点削除エラー:', error);
        alert('拠点の削除に失敗しました');
    }
}

// ユーザー編集モーダルを表示
function showEditUserModal(userId, currentUserId, currentUserName) {
    const modalHtml = `
        <h3>ユーザー編集</h3>
        <form id="edit-user-form">
            <div class="form-group">
                <label>ID（システム内部ID）</label>
                <input type="text" value="${userId}" disabled style="background: #f0f0f0;">
            </div>
            <div class="form-group">
                <label for="edit-user-login-id">ユーザーID（ログインID）</label>
                <input type="text" id="edit-user-login-id" value="${currentUserId}" required>
            </div>
            <div class="form-group">
                <label for="edit-user-name">ユーザー名</label>
                <input type="text" id="edit-user-name" value="${currentUserName}" required>
            </div>
            <div class="form-group">
                <label for="edit-user-password">パスワード</label>
                <input type="password" id="edit-user-password" placeholder="変更しない場合は空欄">
                <small style="color: #666;">※空欄の場合、パスワードは変更されません</small>
            </div>
            <div style="display: flex; gap: 10px; margin-top: 20px;">
                <button type="submit" class="btn btn-primary">更新</button>
                <button type="button" class="btn btn-secondary" onclick="closeEditUserModal()">キャンセル</button>
            </div>
        </form>
    `;

    const modal = document.getElementById('chart-modal');
    const modalBody = document.getElementById('chart-modal-body');
    modalBody.innerHTML = modalHtml;
    modal.style.display = 'block';

    document.getElementById('edit-user-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await editUser(userId);
    });

    document.getElementById('chart-modal-close').onclick = closeEditUserModal;
}

// ユーザー編集モーダルを閉じる
function closeEditUserModal() {
    document.getElementById('chart-modal').style.display = 'none';
}

// ユーザー編集処理
async function editUser(userId) {
    const newUserId = document.getElementById('edit-user-login-id').value.trim();
    const newUserName = document.getElementById('edit-user-name').value.trim();
    const newPassword = document.getElementById('edit-user-password').value;

    if (!newUserId || !newUserName) {
        alert('ユーザーIDとユーザー名を入力してください');
        return;
    }

    try {
        const body = {
            userId: newUserId,
            userName: newUserName
        };
        if (newPassword) {
            body.password = newPassword;
        }

        const response = await fetchWithCsrf(`/api/auth/admin/users/${userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        if (response.ok) {
            alert('ユーザーを更新しました');
            closeEditUserModal();
            await loadUsers(selectedLocationId);
        } else {
            alert(data.error || 'ユーザーの更新に失敗しました');
        }
    } catch (error) {
        console.error('ユーザー編集エラー:', error);
        alert('ユーザーの更新に失敗しました');
    }
}

// ユーザー削除
async function deleteUser(userId, userIdName) {
    if (!confirm(`ユーザー「${userIdName}」を削除してもよろしいですか？`)) {
        return;
    }

    try {
        const response = await fetchWithCsrf(`/api/auth/admin/users/${userId}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (response.ok) {
            alert('ユーザーを削除しました');
            await loadUsers(selectedLocationId);
        } else {
            alert(data.error || 'ユーザーの削除に失敗しました');
        }
    } catch (error) {
        console.error('ユーザー削除エラー:', error);
        alert('ユーザーの削除に失敗しました');
    }
}

// 更新ボタン
document.getElementById('refresh-data-btn').addEventListener('click', async () => {
    await loadAllInventoryAndOrders();
});

// 全店舗のデータを読み込み
async function loadAllInventoryAndOrders() {
    try {
        await Promise.all([
            loadAllInventoryData(),
            loadAllOrdersData()
        ]);
    } catch (error) {
        console.error('データ読み込みエラー:', error);
        alert('データの読み込みに失敗しました');
    }
}

// 全店舗の在庫データの読み込み
async function loadAllInventoryData() {
    try {
        const response = await fetch('/api/auth/admin/all-inventory');
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || '在庫データの取得に失敗しました');
        }

        const tbody = document.getElementById('inventory-list');
        tbody.innerHTML = '';

        if (data.products.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #666;">商品が登録されていません</td></tr>';
            return;
        }

        data.products.forEach(product => {
            const row = document.createElement('tr');

            // 発注状況の判定
            let orderStatus = '';
            let orderStatusColor = '';

            if (product.has_pending_order) {
                orderStatus = product.pending_order_status === 'ordered'
                    ? `発注済 (${product.pending_order_quantity}個)`
                    : `発注依頼済 (${product.pending_order_quantity}個)`;
                orderStatusColor = '#1976d2';
            } else if (product.current_stock <= 0) {
                orderStatus = '在庫切れ';
                orderStatusColor = '#d32f2f';
            } else if (product.current_stock <= product.reorder_point) {
                orderStatus = '発注必要';
                orderStatusColor = '#f57c00';
            } else {
                orderStatus = '正常';
                orderStatusColor = '#388e3c';
            }

            row.innerHTML = `
                <td><strong>${product.location_name}</strong> (${product.location_code})</td>
                <td>${product.name}</td>
                <td>${product.category || '-'}</td>
                <td>${product.current_stock}</td>
                <td>${product.reorder_point}</td>
                <td style="color: ${orderStatusColor}; font-weight: bold;">${orderStatus}</td>
            `;

            tbody.appendChild(row);
        });
    } catch (error) {
        console.error('在庫データ読み込みエラー:', error);
        throw error;
    }
}

// 全店舗の発注データの読み込み
async function loadAllOrdersData() {
    try {
        const response = await fetch('/api/auth/admin/all-orders');
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || '発注データの取得に失敗しました');
        }

        const tbody = document.getElementById('orders-list');
        tbody.innerHTML = '';

        // テストの連保を除外
        const filteredOrders = data.orders.filter(order =>
            !order.location_name.includes('テスト') &&
            !order.location_code.includes('test')
        );

        // 依頼日時で降順ソート（新しい順）
        filteredOrders.sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at));

        if (filteredOrders.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: #666;">発注依頼がありません</td></tr>';
            return;
        }

        filteredOrders.forEach(order => {
            const row = document.createElement('tr');

            // ステータスの表示
            const statusMap = {
                'pending': '発注依頼中',
                'ordered': '発注済',
                'received': '受領済',
                'cancelled': 'キャンセル'
            };
            const statusColorMap = {
                'pending': '#f57c00',
                'ordered': '#1976d2',
                'received': '#388e3c',
                'cancelled': '#757575'
            };

            const statusText = statusMap[order.status] || order.status;
            const statusColor = statusColorMap[order.status] || '#000';

            // UTC時間を日本時間に変換（日付のみ）
            const requestedAt = new Date(order.requested_at).toLocaleDateString('ja-JP', {
                timeZone: 'Asia/Tokyo',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            });

            row.innerHTML = `
                <td><strong>${order.location_name}</strong> (${order.location_code})</td>
                <td>${order.product_name}</td>
                <td>${order.current_stock}</td>
                <td>${order.reorder_point}</td>
                <td style="color: ${statusColor}; font-weight: bold;">${statusText}</td>
                <td>${order.username}</td>
                <td>${requestedAt}</td>
                <td>${order.note || '-'}</td>
                <td>
                    ${order.status === 'pending' ? `<button class="btn-small btn-edit" onclick="updateOrderStatus(${order.location_id}, ${order.id}, 'ordered')">発注済み</button>` : '-'}
                </td>
            `;

            tbody.appendChild(row);
        });
    } catch (error) {
        console.error('発注データ読み込みエラー:', error);
        throw error;
    }
}

// 発注依頼一覧をエクセル出力
async function exportOrdersToExcel() {
    try {
        const response = await fetch('/api/auth/admin/all-orders');
        const data = await response.json();

        const filteredOrders = data.orders.filter(order =>
            !order.location_name.includes('テスト') &&
            !order.location_code.includes('test')
        );

        filteredOrders.sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at));

        const statusMap = {
            'pending': '発注依頼中',
            'ordered': '発注済',
            'received': '受領済',
            'cancelled': 'キャンセル'
        };

        const rows = filteredOrders.map(order => ({
            '店舗': `${order.location_name} (${order.location_code})`,
            '商品名': order.product_name,
            '現在庫': order.current_stock,
            '発注点': order.reorder_point,
            'ステータス': statusMap[order.status] || order.status,
            '依頼者': order.username,
            '依頼日時': new Date(order.requested_at).toLocaleDateString('ja-JP', {
                timeZone: 'Asia/Tokyo',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            }),
            '備考': order.note || ''
        }));

        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '発注依頼一覧');

        const today = new Date().toLocaleDateString('ja-JP', {
            timeZone: 'Asia/Tokyo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).replace(/\//g, '');

        XLSX.writeFile(wb, `発注依頼一覧_${today}.xlsx`);
    } catch (error) {
        console.error('エクセル出力エラー:', error);
        alert('エクセル出力に失敗しました');
    }
}

// 発注ステータス更新
async function updateOrderStatus(locationId, orderId, newStatus) {
    if (!confirm('発注ステータスを「発注済み」に更新しますか？')) {
        return;
    }

    try {
        const response = await fetchWithCsrf(`/api/auth/admin/locations/${locationId}/orders/${orderId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });

        const data = await response.json();

        if (response.ok) {
            alert('発注ステータスを更新しました');
            // 全店舗の発注一覧を再読み込み
            await loadAllOrdersData();
        } else {
            alert(data.error || '発注ステータスの更新に失敗しました');
        }
    } catch (error) {
        console.error('発注ステータス更新エラー:', error);
        alert('発注ステータスの更新に失敗しました');
    }
}

// ========== バックアップ機能 ==========

// バックアップタブの初期化
document.addEventListener('DOMContentLoaded', () => {
    // バックアップタブがアクティブになったときに一覧を読み込む
    const backupTab = document.querySelector('[data-tab="backup"]');
    if (backupTab) {
        backupTab.addEventListener('click', () => {
            loadBackups();
        });
    }

    // バックアップ作成ボタン
    const createBackupBtn = document.getElementById('create-backup-btn');
    if (createBackupBtn) {
        createBackupBtn.addEventListener('click', createBackup);
    }

    // バックアップ一覧更新ボタン
    const refreshBackupsBtn = document.getElementById('refresh-backups-btn');
    if (refreshBackupsBtn) {
        refreshBackupsBtn.addEventListener('click', loadBackups);
    }
});

// バックアップを作成
async function createBackup() {
    const button = document.getElementById('create-backup-btn');
    const originalText = button.textContent;

    try {
        button.disabled = true;
        button.textContent = '⏳ バックアップ作成中...';

        const response = await fetchWithCsrf('/api/auth/admin/backup', {
            method: 'POST'
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showBackupStatus(`✓ ${data.message}`, 'success');
            // 一覧を再読み込み
            await loadBackups();
        } else {
            showBackupStatus(`✗ ${data.error || 'バックアップに失敗しました'}`, 'error');
        }
    } catch (error) {
        console.error('バックアップエラー:', error);
        showBackupStatus('✗ バックアップに失敗しました', 'error');
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

// バックアップ一覧を読み込み
async function loadBackups() {
    try {
        const response = await fetch('/api/auth/admin/backups');
        const data = await response.json();

        const tbody = document.getElementById('backups-list');

        if (!data.backups || data.backups.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="4" style="text-align: center; padding: 20px; color: #999;">
                        バックアップファイルがありません
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = data.backups.map(backup => {
            const date = new Date(backup.date);
            const formattedDate = date.toLocaleString('ja-JP', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });

            return `
                <tr>
                    <td>${formattedDate}</td>
                    <td style="font-family: monospace; font-size: 12px;">${backup.filename}</td>
                    <td>${backup.size} MB</td>
                    <td>
                        <button class="btn btn-secondary btn-small" onclick="downloadBackup('${backup.filename}')" style="margin-right: 5px;">
                            📥 ダウンロード
                        </button>
                        <button class="btn btn-small" onclick="restoreBackup('${backup.filename}')" style="background: #ff6b6b; color: white;">
                            🔄 リストア
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (error) {
        console.error('バックアップ一覧取得エラー:', error);
        const tbody = document.getElementById('backups-list');
        tbody.innerHTML = `
            <tr>
                <td colspan="4" style="text-align: center; padding: 20px; color: #dc3545;">
                    バックアップ一覧の取得に失敗しました
                </td>
            </tr>
        `;
    }
}

// バックアップをダウンロード
function downloadBackup(filename) {
    window.location.href = `/api/auth/admin/backup/${filename}`;
}

// バックアップからリストア
async function restoreBackup(filename) {
    const confirmed = confirm(
        `⚠️ 警告: データベースをリストアします\n\n` +
        `バックアップファイル: ${filename}\n\n` +
        `現在のデータベースは自動的にバックアップされた後、` +
        `このバックアップファイルで上書きされます。\n\n` +
        `リストア後はサーバーを再起動する必要があります。\n\n` +
        `続行しますか？`
    );

    if (!confirmed) {
        return;
    }

    try {
        showBackupStatus('⏳ リストア中...', 'info');

        const response = await fetchWithCsrf(`/api/auth/admin/restore/${filename}`, {
            method: 'POST'
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showBackupStatus(`✓ ${data.message}`, 'success');

            // リストア成功後、確認ダイアログを表示
            const restart = confirm(
                'リストアが完了しました。\n\n' +
                'データベースの変更を反映するには、サーバーを再起動する必要があります。\n\n' +
                '今すぐページをリロードしますか？\n' +
                '（fly.ioの場合は、`flyctl apps restart` コマンドでサーバーを再起動してください）'
            );

            if (restart) {
                window.location.reload();
            }
        } else {
            showBackupStatus(`✗ ${data.error || 'リストアに失敗しました'}`, 'error');
        }
    } catch (error) {
        console.error('リストアエラー:', error);
        showBackupStatus('✗ リストアに失敗しました', 'error');
    }
}

// バックアップステータスメッセージを表示
function showBackupStatus(message, type = 'info') {
    const statusDiv = document.getElementById('backup-status');

    const colors = {
        success: '#d4edda',
        error: '#f8d7da',
        info: '#d1ecf1'
    };

    const textColors = {
        success: '#155724',
        error: '#721c24',
        info: '#0c5460'
    };

    statusDiv.innerHTML = `
        <div style="
            padding: 12px 16px;
            background: ${colors[type]};
            color: ${textColors[type]};
            border-radius: 5px;
            border-left: 4px solid ${textColors[type]};
        ">
            ${message}
        </div>
    `;

    // 5秒後に自動的に消す
    setTimeout(() => {
        statusDiv.innerHTML = '';
    }, 5000);
}

// ========== ご意見ボックス機能 ==========

let allFeedbacks = [];

// ご意見一覧を読み込み
async function loadFeedbacks() {
    try {
        const response = await fetch('/api/admin/feedbacks');
        const data = await response.json();

        if (data.success) {
            allFeedbacks = data.feedbacks;
            renderFeedbacks();
        } else {
            console.error('Failed to load feedbacks:', data.error);
        }
    } catch (error) {
        console.error('Load feedbacks error:', error);
    }
}

// ご意見を表示
function renderFeedbacks() {
    const filterValue = document.querySelector('input[name="feedback-filter"]:checked').value;
    const tbody = document.querySelector('#feedbacks-table tbody');
    tbody.innerHTML = '';

    let filteredFeedbacks = allFeedbacks;
    if (filterValue === 'new') {
        filteredFeedbacks = allFeedbacks.filter(f => f.status === 'new');
    } else if (filterValue === 'resolved') {
        filteredFeedbacks = allFeedbacks.filter(f => f.status === 'resolved');
    }

    if (filteredFeedbacks.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px; color: #999;">該当するご意見はありません</td></tr>';
        return;
    }

    filteredFeedbacks.forEach(feedback => {
        const row = document.createElement('tr');
        const date = new Date(feedback.created_at);
        const formattedDate = date.toLocaleString('ja-JP', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });

        const statusBadge = {
            'new': '<span style="background: #ff9800; color: white; padding: 3px 8px; border-radius: 3px; font-size: 12px;">未読</span>',
            'read': '<span style="background: #2196f3; color: white; padding: 3px 8px; border-radius: 3px; font-size: 12px;">既読</span>',
            'resolved': '<span style="background: #4caf50; color: white; padding: 3px 8px; border-radius: 3px; font-size: 12px;">対応済み</span>'
        };

        // 内容を50文字で切り取り
        const excerpt = feedback.feedback_text.length > 50
            ? feedback.feedback_text.substring(0, 50) + '...'
            : feedback.feedback_text;

        row.innerHTML = `
            <td>${formattedDate}</td>
            <td>${feedback.location_name || '不明'}</td>
            <td style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${excerpt}</td>
            <td>${statusBadge[feedback.status]}</td>
            <td>
                <button class="btn btn-secondary" onclick="showFeedbackDetail(${feedback.id})">詳細</button>
            </td>
        `;

        tbody.appendChild(row);
    });
}

// ご意見詳細モーダルを表示
function showFeedbackDetail(feedbackId) {
    const feedback = allFeedbacks.find(f => f.id === feedbackId);
    if (!feedback) return;

    const date = new Date(feedback.created_at);
    const formattedDate = date.toLocaleString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });

    const statusText = {
        'new': '未読',
        'read': '既読',
        'resolved': '対応済み'
    };

    const statusColor = {
        'new': '#ff9800',
        'read': '#2196f3',
        'resolved': '#4caf50'
    };

    const detailContent = document.getElementById('feedback-detail-content');
    detailContent.innerHTML = `
        <h2>ご意見詳細</h2>
        <div style="margin: 20px 0; padding: 20px; background: #f9f9f9; border-radius: 8px;">
            <div style="margin-bottom: 15px;">
                <strong style="color: #666;">投稿日時:</strong>
                <div style="margin-top: 5px;">${formattedDate}</div>
            </div>
            <div style="margin-bottom: 15px;">
                <strong style="color: #666;">拠点:</strong>
                <div style="margin-top: 5px;">${feedback.location_name || '不明'}</div>
            </div>
            <div style="margin-bottom: 15px;">
                <strong style="color: #666;">ステータス:</strong>
                <div style="margin-top: 5px;">
                    <span style="background: ${statusColor[feedback.status]}; color: white; padding: 5px 12px; border-radius: 4px; font-size: 14px;">
                        ${statusText[feedback.status]}
                    </span>
                </div>
            </div>
            <div>
                <strong style="color: #666;">ご意見内容:</strong>
                <div style="margin-top: 10px; padding: 15px; background: white; border-radius: 5px; white-space: pre-wrap; line-height: 1.6;">
                    ${feedback.feedback_text}
                </div>
            </div>
        </div>
        <div style="display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap;">
            ${feedback.status === 'new'
                ? `<button class="btn btn-primary" onclick="updateFeedbackStatusFromModal(${feedback.id}, 'read')">既読にする</button>
                   <button class="btn btn-primary" onclick="updateFeedbackStatusFromModal(${feedback.id}, 'resolved')">対応済みにする</button>`
                : feedback.status === 'read'
                ? `<button class="btn btn-primary" onclick="updateFeedbackStatusFromModal(${feedback.id}, 'resolved')">対応済みにする</button>`
                : ''}
            ${feedback.status === 'resolved'
                ? `<button class="btn btn-danger" onclick="deleteFeedbackFromModal(${feedback.id})">削除</button>`
                : ''}
            <button class="btn btn-secondary" onclick="closeFeedbackDetailModal()">閉じる</button>
        </div>
    `;

    document.getElementById('feedback-detail-modal').style.display = 'flex';
}

// ご意見詳細モーダルを閉じる
function closeFeedbackDetailModal() {
    document.getElementById('feedback-detail-modal').style.display = 'none';
}

// モーダルからステータスを更新
async function updateFeedbackStatusFromModal(feedbackId, newStatus) {
    await updateFeedbackStatus(feedbackId, newStatus);
    closeFeedbackDetailModal();
}

// モーダルから削除
async function deleteFeedbackFromModal(feedbackId) {
    await deleteFeedback(feedbackId);
    closeFeedbackDetailModal();
}

// ご意見のステータスを更新
async function updateFeedbackStatus(feedbackId, newStatus) {
    try {
        const response = await fetchWithCsrf(`/api/admin/feedbacks/${feedbackId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });

        const data = await response.json();

        if (data.success) {
            await loadFeedbacks();
        } else {
            alert('ステータスの更新に失敗しました: ' + data.error);
        }
    } catch (error) {
        console.error('Update feedback status error:', error);
        alert('ステータスの更新に失敗しました');
    }
}

// ご意見を削除
async function deleteFeedback(feedbackId) {
    if (!confirm('このご意見を削除しますか？')) {
        return;
    }

    try {
        const response = await fetchWithCsrf(`/api/admin/feedbacks/${feedbackId}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (data.success) {
            await loadFeedbacks();
        } else {
            alert('削除に失敗しました: ' + data.error);
        }
    } catch (error) {
        console.error('Delete feedback error:', error);
        alert('削除に失敗しました');
    }
}

// フィルターの変更イベント
document.querySelectorAll('input[name="feedback-filter"]').forEach(radio => {
    radio.addEventListener('change', renderFeedbacks);
});

// タブ切り替え時にご意見を読み込む
document.querySelector('.admin-tab[data-tab="feedback"]').addEventListener('click', loadFeedbacks);
