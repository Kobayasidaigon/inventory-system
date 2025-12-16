let selectedLocationId = null;
let viewLocationId = null;
let currentChartProductId = null;
let currentChart = null;

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
    await checkAdminAuth();
    await loadLocations();
    await loadViewLocationSelect();
    initTabs();
    initChartModal();
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
        await fetch('/api/auth/logout', { method: 'POST' });
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
        const response = await fetch('/api/auth/admin/locations', {
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
        const response = await fetch('/api/auth/admin/users', {
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
        const response = await fetch(`/api/auth/admin/locations/${locationId}`, {
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
        const response = await fetch(`/api/auth/admin/locations/${locationId}`, {
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

        const response = await fetch(`/api/auth/admin/users/${userId}`, {
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
        const response = await fetch(`/api/auth/admin/users/${userId}`, {
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

// 拠点選択プルダウンの読み込み
async function loadViewLocationSelect() {
    try {
        const response = await fetch('/api/auth/admin/locations');
        const locations = await response.json();

        const select = document.getElementById('view-location-select');
        select.innerHTML = '<option value="">拠点を選択してください</option>';

        locations.forEach(location => {
            const option = document.createElement('option');
            option.value = location.id;
            option.textContent = `${location.location_name} (${location.location_code})`;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('拠点選択読み込みエラー:', error);
    }
}

// 拠点選択イベント
document.getElementById('view-location-select').addEventListener('change', async (e) => {
    viewLocationId = e.target.value;

    if (viewLocationId) {
        await loadLocationData(viewLocationId);
    } else {
        document.getElementById('inventory-section').style.display = 'none';
        document.getElementById('orders-section').style.display = 'none';
    }
});

// 更新ボタン
document.getElementById('refresh-data-btn').addEventListener('click', async () => {
    if (viewLocationId) {
        await loadLocationData(viewLocationId);
    } else {
        alert('拠点を選択してください');
    }
});

// 拠点データの読み込み
async function loadLocationData(locationId) {
    try {
        await Promise.all([
            loadInventoryData(locationId),
            loadOrdersData(locationId)
        ]);
    } catch (error) {
        console.error('データ読み込みエラー:', error);
        alert('データの読み込みに失敗しました');
    }
}

// 在庫データの読み込み
async function loadInventoryData(locationId) {
    try {
        const response = await fetch(`/api/auth/admin/locations/${locationId}/inventory`);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || '在庫データの取得に失敗しました');
        }

        // セクションを表示
        document.getElementById('inventory-section').style.display = 'block';
        document.getElementById('inventory-location-name').textContent = data.locationName;

        const tbody = document.getElementById('inventory-list');
        tbody.innerHTML = '';

        if (data.products.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #666;">商品が登録されていません</td></tr>';
            return;
        }

        data.products.forEach(product => {
            const row = document.createElement('tr');

            // 状態判定
            let status = '';
            let statusColor = '';
            if (product.current_stock <= 0) {
                status = '在庫切れ';
                statusColor = '#d32f2f';
            } else if (product.current_stock <= product.reorder_point) {
                status = '発注必要';
                statusColor = '#f57c00';
            } else {
                status = '正常';
                statusColor = '#388e3c';
            }

            row.innerHTML = `
                <td>${product.name}</td>
                <td>${product.category || '-'}</td>
                <td>${product.current_stock}</td>
                <td>${product.reorder_point}</td>
                <td style="color: ${statusColor}; font-weight: bold;">${status}</td>
                <td>
                    <button class="btn btn-small btn-secondary" onclick="showProductChart(${product.id}, '${product.name.replace(/'/g, "\\'")}')">在庫履歴</button>
                </td>
            `;

            tbody.appendChild(row);
        });
    } catch (error) {
        console.error('在庫データ読み込みエラー:', error);
        throw error;
    }
}

// 発注データの読み込み
async function loadOrdersData(locationId) {
    try {
        const response = await fetch(`/api/auth/admin/locations/${locationId}/orders`);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || '発注データの取得に失敗しました');
        }

        // セクションを表示
        document.getElementById('orders-section').style.display = 'block';
        document.getElementById('orders-location-name').textContent = data.locationName;

        const tbody = document.getElementById('orders-list');
        tbody.innerHTML = '';

        if (data.orders.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: #666;">発注依頼がありません</td></tr>';
            return;
        }

        data.orders.forEach(order => {
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

            const requestedAt = new Date(order.requested_at).toLocaleString('ja-JP');

            row.innerHTML = `
                <td>${order.product_name}</td>
                <td>${order.requested_quantity}</td>
                <td>${order.current_stock}</td>
                <td style="color: ${statusColor}; font-weight: bold;">${statusText}</td>
                <td>${order.username}</td>
                <td>${requestedAt}</td>
                <td>${order.note || '-'}</td>
                <td>
                    ${order.status === 'pending' ? `<button class="btn-small btn-edit" onclick="updateOrderStatus(${order.id}, 'ordered')">発注済み</button>` : '-'}
                </td>
            `;

            tbody.appendChild(row);
        });
    } catch (error) {
        console.error('発注データ読み込みエラー:', error);
        throw error;
    }
}

// 発注ステータス更新
async function updateOrderStatus(orderId, newStatus) {
    if (!confirm('発注ステータスを「発注済み」に更新しますか？')) {
        return;
    }

    try {
        const locationSelect = document.getElementById('view-location-select');
        const locationId = locationSelect.value;

        if (!locationId) {
            alert('拠点が選択されていません');
            return;
        }

        const response = await fetch(`/api/auth/admin/locations/${locationId}/orders/${orderId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });

        const data = await response.json();

        if (response.ok) {
            alert('発注ステータスを更新しました');
            // 発注一覧を再読み込み
            await loadOrdersData(locationId);
        } else {
            alert(data.error || '発注ステータスの更新に失敗しました');
        }
    } catch (error) {
        console.error('発注ステータス更新エラー:', error);
        alert('発注ステータスの更新に失敗しました');
    }
}

// グラフモーダルの初期化
function initChartModal() {
    const modal = document.getElementById('chart-modal');
    const closeBtn = document.getElementById('chart-modal-close');
    const reloadBtn = document.getElementById('chart-reload-btn');
    const periodSelect = document.getElementById('chart-period-select');

    // 閉じるボタン
    closeBtn.addEventListener('click', () => {
        modal.classList.remove('show');
        if (currentChart) {
            currentChart.destroy();
            currentChart = null;
        }
    });

    // モーダル外クリックで閉じる
    window.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('show');
            if (currentChart) {
                currentChart.destroy();
                currentChart = null;
            }
        }
    });

    // 更新ボタン
    reloadBtn.addEventListener('click', async () => {
        if (currentChartProductId && viewLocationId) {
            const days = periodSelect.value;
            await loadChartData(viewLocationId, currentChartProductId, days);
        }
    });

    // 期間変更時に自動更新
    periodSelect.addEventListener('change', async () => {
        if (currentChartProductId && viewLocationId) {
            const days = periodSelect.value;
            await loadChartData(viewLocationId, currentChartProductId, days);
        }
    });
}

// グラフ表示
async function showProductChart(productId, productName) {
    if (!viewLocationId) {
        alert('拠点を選択してください');
        return;
    }

    currentChartProductId = productId;
    document.getElementById('chart-product-name').textContent = `${productName} の在庫推移`;
    document.getElementById('chart-modal').classList.add('show');

    const days = document.getElementById('chart-period-select').value;
    await loadChartData(viewLocationId, productId, days);
}

// グラフデータ読み込み
async function loadChartData(locationId, productId, days) {
    try {
        const response = await fetch(`/api/auth/admin/locations/${locationId}/chart/${productId}?days=${days}`);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'グラフデータの取得に失敗しました');
        }

        // 既存のグラフを破棄
        if (currentChart) {
            currentChart.destroy();
        }

        // グラフを描画
        const ctx = document.getElementById('admin-stock-chart').getContext('2d');
        currentChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.labels,
                datasets: [{
                    label: '在庫数',
                    data: data.stocks,
                    borderColor: '#667eea',
                    backgroundColor: 'rgba(102, 126, 234, 0.1)',
                    tension: 0.1,
                    fill: true
                }, {
                    label: '発注点',
                    data: Array(data.labels.length).fill(data.reorderPoint),
                    borderColor: '#f57c00',
                    borderDash: [5, 5],
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top'
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: '在庫数'
                        }
                    },
                    x: {
                        title: {
                            display: true,
                            text: '日付'
                        }
                    }
                }
            }
        });
    } catch (error) {
        console.error('グラフデータ読み込みエラー:', error);
        alert('グラフデータの読み込みに失敗しました: ' + error.message);
    }
}
