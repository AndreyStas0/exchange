// server.js - Backend сервер для системи обміну ордерами
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8401038127:AAFuocGyyMpZnI86cum61-PPyQvGWmfJKgk';
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || '-1003334842127';
const TELEGRAM_LOGIN_BOT_TOKEN = process.env.TELEGRAM_LOGIN_BOT_TOKEN || TELEGRAM_BOT_TOKEN;

const app = express();
const PORT = process.env.PORT || 3000;

let telegramNotificationsDisabledReason = null;

async function sendTelegramNotification(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
        console.log('⚠️ Telegram not configured');
        return;
    }

    if (telegramNotificationsDisabledReason) {
        console.log('⚠️ Telegram notifications disabled:', telegramNotificationsDisabledReason);
        return;
    }

    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHANNEL_ID,
                text: message,
                parse_mode: 'HTML'
            })
        });

        if (!response.ok) {
            const body = await response.text();
            console.error('Telegram API error:', body);

            if (response.status === 401 || response.status === 403) {
                telegramNotificationsDisabledReason = 'Authentication failed. Check TELEGRAM_BOT_TOKEN/TELEGRAM_CHANNEL_ID configuration.';
            }
        }
    } catch (err) {
        console.error('Error sending Telegram notification:', err);
    }
}

function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0].trim()
        || req.headers['x-real-ip']
        || req.connection.remoteAddress
        || req.socket.remoteAddress
        || 'unknown';
}

// Створюємо папку для зображень якщо не існує
const uploadsDir = path.join(__dirname, 'uploads');
console.log('📁 Current directory (__dirname):', __dirname);
console.log('📁 Uploads directory path:', uploadsDir);

if (!fs.existsSync(uploadsDir)) {
    console.log('📁 Creating uploads directory...');
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log('✅ Uploads directory created');
} else {
    console.log('✅ Uploads directory already exists');
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Для завантаження зображень

// Віддаємо статичні файли
app.use(express.static(path.join(__dirname)));

// Віддаємо зображення
app.use('/uploads', express.static(uploadsDir));

// Головна сторінка
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Підключення до NeonDB
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Тестування підключення
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Помилка підключення до бази даних:', err.stack);
    } else {
        console.log('✅ Підключено до NeonDB');
        release();
    }
});

// Ініціалізація таблиць
async function initDatabase() {
    const client = await pool.connect();
    try {
        // Таблиця балансів (між парами кабінетів)
        await client.query(`
            CREATE TABLE IF NOT EXISTS balances (
                id SERIAL PRIMARY KEY,
                cabinet_from VARCHAR(50) NOT NULL,
                cabinet_to VARCHAR(50) NOT NULL,
                amount DECIMAL(10, 2) DEFAULT 0,
                UNIQUE(cabinet_from, cabinet_to)
            )
        `);

        // Таблиця ордерів
        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                request_id INTEGER,
                from_cabinet VARCHAR(50) NOT NULL,
                to_cabinet VARCHAR(50) NOT NULL,
                type VARCHAR(20) NOT NULL,
                amount_usdt DECIMAL(10, 2) NOT NULL,
                amount_local DECIMAL(10, 2),
                card_number VARCHAR(100),
                iban VARCHAR(100),
                tax_number VARCHAR(100),
                cvu VARCHAR(100),
                full_name VARCHAR(200),
                note TEXT,
                status VARCHAR(20) DEFAULT 'pending',
                receipts JSONB,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Таблиця запитів на ордери
        await client.query(`
            CREATE TABLE IF NOT EXISTS order_requests (
                id SERIAL PRIMARY KEY,
                from_cabinet VARCHAR(50) NOT NULL,
                to_cabinet VARCHAR(50) NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                type VARCHAR(20) NOT NULL,
                remaining_amount DECIMAL(10, 2) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Таблиця виводів
        await client.query(`
            CREATE TABLE IF NOT EXISTS withdrawals (
                id SERIAL PRIMARY KEY,
                from_cabinet VARCHAR(50) NOT NULL,
                to_cabinet VARCHAR(50) NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                address TEXT NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                txid TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Таблиця прихованих ордерів (для кожного кабінету окремо)
        await client.query(`
            CREATE TABLE IF NOT EXISTS hidden_orders (
                id SERIAL PRIMARY KEY,
                cabinet VARCHAR(50) NOT NULL,
                order_id INTEGER NOT NULL,
                UNIQUE(cabinet, order_id)
            )
        `);

        // Таблиця прихованих виводів (для кожного кабінету окремо)
        await client.query(`
            CREATE TABLE IF NOT EXISTS hidden_withdrawals (
                id SERIAL PRIMARY KEY,
                cabinet VARCHAR(50) NOT NULL,
                withdrawal_id INTEGER NOT NULL,
                UNIQUE(cabinet, withdrawal_id)
            )
        `);

        // Таблиця логів адміністратора
        await client.query(`
            CREATE TABLE IF NOT EXISTS admin_logs (
                id SERIAL PRIMARY KEY,
                admin_name VARCHAR(50) NOT NULL,
                action_type VARCHAR(50) NOT NULL,
                cabinet_from VARCHAR(50),
                cabinet_to VARCHAR(50),
                amount_old DECIMAL(10, 2),
                amount_new DECIMAL(10, 2),
                comment TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Додаємо відсутні колонки (для зворотної сумісності)
        await client.query(
            "ALTER TABLE admin_logs ADD COLUMN IF NOT EXISTS cabinet_from VARCHAR(50)"
        );
        await client.query(
            "ALTER TABLE admin_logs ADD COLUMN IF NOT EXISTS cabinet_to VARCHAR(50)"
        );
        await client.query(
            "ALTER TABLE admin_logs ADD COLUMN IF NOT EXISTS comment TEXT"
        );

        // Таблиця активних сесій
        await client.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id SERIAL PRIMARY KEY,
                cabinet VARCHAR(50) NOT NULL,
                session_id VARCHAR(255) UNIQUE NOT NULL,
                ip_address VARCHAR(45),
                user_agent TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                last_activity TIMESTAMP DEFAULT NOW()
            )
        `);

        // Таблиця логування входів
        await client.query(`
            CREATE TABLE IF NOT EXISTS login_logs (
                id SERIAL PRIMARY KEY,
                cabinet VARCHAR(50) NOT NULL,
                ip_address VARCHAR(45),
                user_agent TEXT,
                status VARCHAR(50),
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        console.log('✅ База даних ініціалізована');
    } catch (err) {
        console.error('❌ Помилка ініціалізації бази даних:', err);
    } finally {
        client.release();
    }
}

// Ініціалізація при запуску
initDatabase();

// ==================== API ENDPOINTS ====================

// Функція для збереження base64 зображення як файл
function saveBase64AsFile(base64Data) {
    try {
        // Генеруємо унікальне ім'я файлу
        const fileName = `receipt_${Date.now()}_${Math.random().toString(36).substring(7)}.png`;
        const filePath = path.join(uploadsDir, fileName);
        
        console.log('💾 Saving receipt:');
        console.log('  - File name:', fileName);
        console.log('  - Full path:', filePath);
        
        // Витягуємо base64 дані (прибираємо "data:image/png;base64,")
        const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Image, 'base64');
        
        console.log('  - Buffer size:', buffer.length, 'bytes');
        
        // Зберігаємо файл
        fs.writeFileSync(filePath, buffer);
        
        // Перевіряємо чи файл створений
        if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            console.log('  ✅ File saved successfully, size:', stats.size, 'bytes');
        } else {
            console.log('  ❌ File NOT saved!');
        }
        
        // Повертаємо URL до файлу
        const url = `/uploads/${fileName}`;
        console.log('  - URL:', url);
        return url;
    } catch (error) {
        console.error('❌ Error saving base64 image:', error);
        return null;
    }
}

// Конвертувати base64 квитанції в файли
app.post('/api/convert-receipts', async (req, res) => {
    const { receipts } = req.body;
    
    try {
        const fileUrls = [];
        
        for (const receipt of receipts) {
            if (receipt.startsWith('data:image')) {
                const fileUrl = saveBase64AsFile(receipt);
                if (fileUrl) {
                    fileUrls.push(fileUrl);
                }
            } else {
                // Якщо це вже URL - залишаємо як є
                fileUrls.push(receipt);
            }
        }
        
        res.json({ success: true, fileUrls });
    } catch (error) {
        console.error('Error converting receipts:', error);
        res.status(500).json({ error: 'Помилка конвертації квитанцій' });
    }
});

// Отримати історію операцій для кабінету
app.get('/api/history/:cabinet', async (req, res) => {
    const { cabinet } = req.params;
    
    try {
        // Отримуємо оплачені ордери
        const ordersResult = await pool.query(
            `SELECT 'order' as operation_type, id, from_cabinet, to_cabinet, 
                    amount_usdt as amount, amount_local, 
                    card_number, iban, tax_number, cvu, full_name as fio, 
                    created_at, status, type as order_type,
                    receipts as receipt_files, note as comment
             FROM orders 
             WHERE status = 'completed' AND (from_cabinet = $1 OR to_cabinet = $1)
             ORDER BY created_at DESC`,
            [cabinet]
        );

        // Отримуємо підтверджені виводи
        const withdrawalsResult = await pool.query(
            `SELECT 'withdrawal' as operation_type, id, from_cabinet, to_cabinet, amount, 
                    created_at, status, txid
             FROM withdrawals 
             WHERE status = 'completed' AND (from_cabinet = $1 OR to_cabinet = $1)
             ORDER BY created_at DESC`,
            [cabinet]
        );

        // Отримуємо зміни балансів від адміна
        const balanceChangesResult = await pool.query(
            `SELECT 'balance_adjustment' as operation_type, id, admin_name, cabinet_from, cabinet_to,
                    amount_old, amount_new, comment, created_at
             FROM admin_logs
             WHERE action_type = 'balance_update' AND (cabinet_from = $1 OR cabinet_to = $1)
             ORDER BY created_at DESC`,
            [cabinet]
        );

        // Об'єднуємо та сортуємо за датою
        const history = [...ordersResult.rows, ...withdrawalsResult.rows, ...balanceChangesResult.rows]
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json(history);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка отримання історії' });
    }
});

// Отримати історію операцій для адміна (всі кабінети)
app.get('/api/admin/history', async (req, res) => {
    const { cabinet } = req.query;

    const cabinetFilter = cabinet && cabinet !== 'all' ? cabinet : null;

    try {
        const ordersQuery = {
            text: `SELECT 'order' as operation_type, id, from_cabinet, to_cabinet,
                          amount_usdt as amount, amount_local,
                          card_number, iban, tax_number, cvu, full_name as fio,
                          created_at, status, type as order_type,
                          receipts as receipt_files, note as comment
                   FROM orders
                   ${cabinetFilter ? 'WHERE from_cabinet = $1 OR to_cabinet = $1' : ''}
                   ORDER BY created_at DESC`,
            values: cabinetFilter ? [cabinetFilter] : []
        };

        const withdrawalsQuery = {
            text: `SELECT 'withdrawal' as operation_type, id, from_cabinet, to_cabinet, amount,
                          created_at, status, txid
                   FROM withdrawals
                   ${cabinetFilter ? 'WHERE from_cabinet = $1 OR to_cabinet = $1' : ''}
                   ORDER BY created_at DESC`,
            values: cabinetFilter ? [cabinetFilter] : []
        };

        const balanceChangesQuery = {
            text: `SELECT 'balance_adjustment' as operation_type, id, admin_name, cabinet_from, cabinet_to,
                          amount_old, amount_new, comment, created_at
                   FROM admin_logs
                   WHERE action_type = 'balance_update'
                   ${cabinetFilter ? 'AND (cabinet_from = $1 OR cabinet_to = $1)' : ''}
                   ORDER BY created_at DESC`,
            values: cabinetFilter ? [cabinetFilter] : []
        };

        const [ordersResult, withdrawalsResult, balanceChangesResult] = await Promise.all([
            pool.query(ordersQuery),
            pool.query(withdrawalsQuery),
            pool.query(balanceChangesQuery)
        ]);

        const history = [...ordersResult.rows, ...withdrawalsResult.rows, ...balanceChangesResult.rows]
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json(history);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка отримання історії' });
    }
});

// Отримати всі баланси для конкретного кабінету
app.get('/api/balances/:cabinet', async (req, res) => {
    const { cabinet } = req.params;
    
    try {
        // Отримуємо всі баланси де цей кабінет є учасником
        const result = await pool.query(
            `SELECT cabinet_from, cabinet_to, amount 
             FROM balances 
             WHERE cabinet_from = $1 OR cabinet_to = $1`,
            [cabinet]
        );
        
        const balances = {};
        const cabinets = [
            'Кабінет 1 UA', 'Кабінет 2 UA', 'Кабінет 3 UA', 'Кабінет 4 UA',
            'Кабінет 1 ARS', 'Кабінет 2 ARS'
        ];
        
        // Ініціалізуємо всі баланси як 0
        cabinets.forEach(cab => {
            if (cab !== cabinet) {
                balances[cab] = 0;
            }
        });
        
        // Розраховуємо баланси
        result.rows.forEach(row => {
            const amount = parseFloat(row.amount);
            
            if (row.cabinet_from === cabinet) {
                // Ми в from - показуємо amount як є (+ або -)
                balances[row.cabinet_to] = amount;
            } else if (row.cabinet_to === cabinet) {
                // Ми в to - інвертуємо amount
                balances[row.cabinet_from] = -amount;
            }
        });
        
        res.json(balances);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка отримання балансів' });
    }
});

// Отримати всі баланси (для адміна)
app.get('/api/admin/balances/all', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, cabinet_from, cabinet_to, amount FROM balances ORDER BY cabinet_from, cabinet_to`
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка отримання балансів' });
    }
});

// Оновити баланс (для адміна)
app.patch('/api/admin/balances/:id', async (req, res) => {
    const { id } = req.params;
    const { amount, admin_name, comment } = req.body;

    if (!admin_name) {
        return res.status(400).json({ error: 'Не вказано адміністратора' });
    }

    if (!comment || !comment.trim()) {
        return res.status(400).json({ error: 'Коментар є обов\'язковим' });
    }

    try {
        const balanceResult = await pool.query(
            'SELECT * FROM balances WHERE id = $1',
            [id]
        );

        if (balanceResult.rows.length === 0) {
            return res.status(404).json({ error: 'Баланс не знайдено' });
        }

        const balance = balanceResult.rows[0];

        await pool.query(
            'UPDATE balances SET amount = $1 WHERE id = $2',
            [amount, id]
        );

        await pool.query(
            `INSERT INTO admin_logs (admin_name, action_type, cabinet_from, cabinet_to, amount_old, amount_new, comment)
             VALUES ($1, 'balance_update', $2, $3, $4, $5, $6)`,
            [
                admin_name,
                balance.cabinet_from,
                balance.cabinet_to,
                balance.amount,
                amount,
                comment.trim()
            ]
        );

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка оновлення балансу' });
    }
});

// Отримати всі ордери для конкретного кабінету (виключаючи приховані)
app.get('/api/orders/:cabinet', async (req, res) => {
    const { cabinet } = req.params;
    
    try {
        const result = await pool.query(`
            SELECT o.* FROM orders o
            WHERE (o.from_cabinet = $1 OR o.to_cabinet = $1)
            AND o.id NOT IN (
                SELECT order_id FROM hidden_orders WHERE cabinet = $1
            )
            ORDER BY o.created_at DESC
        `, [cabinet]);
        
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка отримання ордерів' });
    }
});

// Створити новий ордер
app.post('/api/orders', async (req, res) => {
    const {
        request_id, from_cabinet, to_cabinet, type, amount_usdt,
        amount_local, card_number, iban, tax_number, cvu, full_name, note
    } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO orders (
                request_id, from_cabinet, to_cabinet, type, amount_usdt,
                amount_local, card_number, iban, tax_number, cvu, full_name, note
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING *`,
            [request_id, from_cabinet, to_cabinet, type, amount_usdt,
             amount_local, card_number, iban, tax_number, cvu, full_name, note]
        );

        // Оновити залишок запиту
        if (request_id) {
            await pool.query(
                'UPDATE order_requests SET remaining_amount = remaining_amount - $1 WHERE id = $2',
                [amount_usdt, request_id]
            );
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка створення ордеру' });
    }
});

// Оновити статус ордеру (оплата)
app.patch('/api/orders/:id/pay', async (req, res) => {
    const { id } = req.params;
    const { receipts } = req.body;

    try {
        // Отримати ордер
        const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
        const order = orderResult.rows[0];

        // ПЕРЕВІРКА: Якщо ордер вже оплачений - не обробляємо повторно
        if (order.status === 'completed') {
            return res.status(400).json({ error: 'Ордер вже оплачений' });
        }

        // Оновити статус
        await pool.query(
            'UPDATE orders SET status = $1, receipts = $2 WHERE id = $3',
            ['completed', receipts ? JSON.stringify(receipts) : null, id]
        );

        // Оновити баланс між кабінетами
        // НОВА ЛОГІКА: При оплаті ВІДНІМАЄМО (зворотня операція)
        // Знаходимо запис (може бути from->to або to->from)
        const balanceCheck = await pool.query(
            `SELECT * FROM balances 
             WHERE (cabinet_from = $1 AND cabinet_to = $2) 
             OR (cabinet_from = $2 AND cabinet_to = $1)`,
            [order.from_cabinet, order.to_cabinet]
        );

        if (balanceCheck.rows.length > 0) {
            const balance = balanceCheck.rows[0];
            let newAmount;
            
            if (balance.cabinet_from === order.from_cabinet) {
                // Запис from->to, ВІДНІМАЄМО amount (хто відправив зменшує борг)
                newAmount = parseFloat(balance.amount) - parseFloat(order.amount_usdt);
            } else {
                // Запис to->from, ДОДАЄМО amount (хто оплатив збільшує кредит)
                newAmount = parseFloat(balance.amount) + parseFloat(order.amount_usdt);
            }
            
            await pool.query(
                'UPDATE balances SET amount = $1 WHERE id = $2',
                [newAmount, balance.id]
            );
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка оплати ордеру' });
    }
});

// Скасувати ордер
app.patch('/api/orders/:id/cancel', async (req, res) => {
    const { id } = req.params;

    try {
        // Отримати ордер
        const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
        const order = orderResult.rows[0];

        // Оновити статус
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['cancelled', id]);

        // Повернути суму до запиту
        if (order.request_id) {
            await pool.query(
                'UPDATE order_requests SET remaining_amount = remaining_amount + $1 WHERE id = $2',
                [order.amount_usdt, order.request_id]
            );
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка скасування ордеру' });
    }
});

// Приховати ордер (локально для кабінету)
app.post('/api/orders/:id/hide', async (req, res) => {
    const { id } = req.params;
    const { cabinet } = req.body;

    try {
        await pool.query(
            'INSERT INTO hidden_orders (cabinet, order_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [cabinet, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка приховування ордеру' });
    }
});

// Отримати всі запити на ордери
app.get('/api/order-requests', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM order_requests WHERE remaining_amount > 0 ORDER BY created_at DESC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка отримання запитів' });
    }
});

// Створити запит на ордери
app.post('/api/order-requests', async (req, res) => {
    const { from_cabinet, to_cabinet, amount, type } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO order_requests (from_cabinet, to_cabinet, amount, type, remaining_amount)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [from_cabinet, to_cabinet, amount, type, amount]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка створення запиту' });
    }
});

// Відмінити запит на ордери
app.delete('/api/order-requests/:id', async (req, res) => {
    const { id } = req.params;

    try {
        await pool.query('DELETE FROM order_requests WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка відміни запиту' });
    }
});

// Отримати всі виводи для конкретного кабінету (виключаючи приховані)
app.get('/api/withdrawals/:cabinet', async (req, res) => {
    const { cabinet } = req.params;
    
    try {
        const result = await pool.query(`
            SELECT w.* FROM withdrawals w
            WHERE (w.from_cabinet = $1 OR w.to_cabinet = $1)
            AND w.id NOT IN (
                SELECT withdrawal_id FROM hidden_withdrawals WHERE cabinet = $1
            )
            ORDER BY w.created_at DESC
        `, [cabinet]);
        
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка отримання виводів' });
    }
});

// Створити запит на вивід
app.post('/api/withdrawals', async (req, res) => {
    const { from_cabinet, to_cabinet, amount, address } = req.body;

    try {
        // Дозволяємо створювати вивід навіть якщо баланс 0 або мінусовий
        const result = await pool.query(
            `INSERT INTO withdrawals (from_cabinet, to_cabinet, amount, address)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [from_cabinet, to_cabinet, amount, address]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка створення виводу' });
    }
});

// Підтвердити вивід
app.patch('/api/withdrawals/:id/confirm', async (req, res) => {
    const { id } = req.params;
    const { txid } = req.body;

    try {
        // Отримати вивід
        const withdrawalResult = await pool.query('SELECT * FROM withdrawals WHERE id = $1', [id]);
        const withdrawal = withdrawalResult.rows[0];

        // ПЕРЕВІРКА: Якщо вивід вже підтверджений - не обробляємо повторно
        if (withdrawal.status === 'completed') {
            return res.status(400).json({ error: 'Вивід вже підтверджений' });
        }

        // Оновити статус
        await pool.query(
            'UPDATE withdrawals SET status = $1, txid = $2 WHERE id = $3',
            ['completed', txid, id]
        );

        // Оновити баланс між кабінетами
        const balanceCheck = await pool.query(
            `SELECT * FROM balances 
             WHERE (cabinet_from = $1 AND cabinet_to = $2) 
             OR (cabinet_from = $2 AND cabinet_to = $1)`,
            [withdrawal.from_cabinet, withdrawal.to_cabinet]
        );

        if (balanceCheck.rows.length > 0) {
            const balance = balanceCheck.rows[0];
            let newAmount;
            
            if (balance.cabinet_from === withdrawal.from_cabinet) {
                // Запис from->to, віднімаємо (хто запросив вивід зменшує свій плюс)
                newAmount = parseFloat(balance.amount) - parseFloat(withdrawal.amount);
            } else {
                // Запис to->from, додаємо (хто підтверджує збільшує свій плюс)
                newAmount = parseFloat(balance.amount) + parseFloat(withdrawal.amount);
            }
            
            await pool.query(
                'UPDATE balances SET amount = $1 WHERE id = $2',
                [newAmount, balance.id]
            );
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка підтвердження виводу' });
    }
});

// Відмінити запит на вивід
app.delete('/api/withdrawals/:id', async (req, res) => {
    const { id } = req.params;

    try {
        await pool.query('DELETE FROM withdrawals WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка відміни виводу' });
    }
});

// Приховати вивід (локально для кабінету)
app.post('/api/withdrawals/:id/hide', async (req, res) => {
    const { id } = req.params;
    const { cabinet } = req.body;

    try {
        await pool.query(
            'INSERT INTO hidden_withdrawals (cabinet, withdrawal_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [cabinet, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка приховування виводу' });
    }
});

// Статичні файли (frontend)
app.use(express.static('public'));

// Запуск серверу
// ============================================
// ACCESS KEY AUTHENTICATION
// ============================================

// Авторизація по ключу (перевірка в БД) з унікальними сесіями та відстеженням IP
app.post('/api/auth/login', async (req, res) => {
    const { key } = req.body;
    const ipAddress = getClientIP(req);
    const userAgent = req.headers['user-agent'] || '';

    try {
        // Шукаємо ключ в базі даних
        const result = await pool.query(
            'SELECT * FROM access_keys WHERE access_key = $1 AND is_active = true',
            [key]
        );

        if (result.rows.length > 0) {
            const keyData = result.rows[0];
            const cabinet = keyData.cabinet;

            // Завершуємо попередні сесії цього кабінету
            await pool.query('DELETE FROM sessions WHERE cabinet = $1', [cabinet]);

            // Перевіряємо останній успішний вхід для виявлення зміни IP
            const lastLogin = await pool.query(
                `SELECT ip_address FROM login_logs
                 WHERE cabinet = $1 AND status = 'success'
                 ORDER BY created_at DESC LIMIT 1`,
                [cabinet]
            );

            let ipChanged = false;
            if (lastLogin.rows.length > 0 && lastLogin.rows[0].ip_address !== ipAddress) {
                ipChanged = true;

                const message = `
🔐 <b>НОВА АВТОРИЗАЦІЯ З ІНШОГО IP</b>

👤 Кабінет: <code>${cabinet}</code>
🌐 Попередній IP: <code>${lastLogin.rows[0].ip_address}</code>
🌐 Новий IP: <code>${ipAddress}</code>
🕐 Час: ${new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' })}

${userAgent ? `📱 Пристрій: ${userAgent.substring(0, 100)}` : ''}
                `.trim();

                await sendTelegramNotification(message);
            }

            // Створюємо нову сесію
            const sessionId = crypto.randomBytes(32).toString('hex');
            await pool.query(
                `INSERT INTO sessions (cabinet, session_id, ip_address, user_agent)
                 VALUES ($1, $2, $3, $4)`,
                [cabinet, sessionId, ipAddress, userAgent]
            );

            // Логуємо успішний вхід
            await pool.query(
                `INSERT INTO login_logs (cabinet, ip_address, user_agent, status)
                 VALUES ($1, $2, $3, $4)`,
                [cabinet, ipAddress, userAgent, 'success']
            );

            // Оновлюємо час останнього використання
            await pool.query(
                'UPDATE access_keys SET last_used = NOW() WHERE id = $1',
                [keyData.id]
            );

            res.json({
                success: true,
                cabinet: cabinet,
                sessionId: sessionId,
                ipChanged: ipChanged
            });
        } else {
            await pool.query(
                `INSERT INTO login_logs (cabinet, ip_address, user_agent, status)
                 VALUES ($1, $2, $3, $4)`,
                ['unknown', ipAddress, userAgent, 'invalid_key']
            );

            res.json({
                success: false,
                error: 'Невірний ключ доступу'
            });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Вихід (видалення сесії)
app.post('/api/auth/logout', async (req, res) => {
    const { sessionId } = req.body;

    try {
        await pool.query('DELETE FROM sessions WHERE session_id = $1', [sessionId]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка виходу' });
    }
});

// Перевірка активності сесії (heartbeat)
app.post('/api/auth/heartbeat', async (req, res) => {
    const { sessionId } = req.body;

    try {
        const result = await pool.query(
            'UPDATE sessions SET last_activity = NOW() WHERE session_id = $1 RETURNING *',
            [sessionId]
        );

        if (result.rows.length > 0) {
            res.json({ valid: true });
        } else {
            res.json({ valid: false });
        }
    } catch (err) {
        console.error(err);
        res.json({ valid: false });
    }
});

// Отримати всі ключі (для адмін панелі)
app.get('/api/auth/keys', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, access_key, cabinet, description, is_active, created_at, last_used FROM access_keys ORDER BY cabinet'
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Створити новий ключ
app.post('/api/auth/keys', async (req, res) => {
    const { access_key, cabinet, description } = req.body;
    
    try {
        const result = await pool.query(
            'INSERT INTO access_keys (access_key, cabinet, description) VALUES ($1, $2, $3) RETURNING *',
            [access_key, cabinet, description]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        if (err.code === '23505') { // Duplicate key
            res.status(400).json({ error: 'Цей ключ вже існує' });
        } else {
            res.status(500).json({ error: 'Помилка сервера' });
        }
    }
});

// Деактивувати ключ
app.patch('/api/auth/keys/:id/deactivate', async (req, res) => {
    const { id } = req.params;
    
    try {
        await pool.query(
            'UPDATE access_keys SET is_active = false WHERE id = $1',
            [id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Активувати ключ
app.patch('/api/auth/keys/:id/activate', async (req, res) => {
    const { id } = req.params;

    try {
        await pool.query(
            'UPDATE access_keys SET is_active = true WHERE id = $1',
            [id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Очищення старих сесій
setInterval(async () => {
    try {
        await pool.query(
            `DELETE FROM sessions WHERE last_activity < NOW() - INTERVAL '1 hour'`
        );
    } catch (err) {
        console.error('Error cleaning sessions:', err);
    }
}, 3600000);

// Видалити ключ
app.delete('/api/auth/keys/:id', async (req, res) => {
    const { id } = req.params;

    try {
        await pool.query('DELETE FROM access_keys WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// ============================================
// TELEGRAM AUTHENTICATION
// ============================================

// Перевірка Telegram авторизаційних даних
function verifyTelegramAuth(authData) {
    const checkHash = authData.hash;
    delete authData.hash;
    
    const dataCheckArr = [];
    for (const key in authData) {
        dataCheckArr.push(`${key}=${authData[key]}`);
    }
    dataCheckArr.sort();
    const dataCheckString = dataCheckArr.join('\n');
    
    const secretKey = crypto.createHash('sha256').update(TELEGRAM_LOGIN_BOT_TOKEN).digest();
    const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    
    return hash === checkHash;
}

// Telegram Login - перевірка та збереження користувача
app.post('/api/telegram/login', async (req, res) => {
    const authData = req.body;
    
    try {
        // Перевіряємо підпис Telegram
        if (!verifyTelegramAuth(authData)) {
            return res.status(401).json({ error: 'Invalid Telegram authentication' });
        }
        
        const telegramId = authData.id;
        
        // Перевіряємо чи є користувач в базі
        const userResult = await pool.query(
            'SELECT * FROM telegram_users WHERE telegram_id = $1',
            [telegramId]
        );
        
        if (userResult.rows.length > 0) {
            // Користувач існує
            const user = userResult.rows[0];
            
            // Оновлюємо інформацію
            await pool.query(
                `UPDATE telegram_users 
                 SET username = $1, first_name = $2, last_name = $3, photo_url = $4, updated_at = NOW()
                 WHERE telegram_id = $5`,
                [authData.username, authData.first_name, authData.last_name, authData.photo_url, telegramId]
            );
            
            res.json({
                success: true,
                user: {
                    telegram_id: user.telegram_id,
                    cabinet: user.cabinet,
                    first_name: authData.first_name,
                    username: authData.username,
                    photo_url: authData.photo_url,
                    has_cabinet: !!user.cabinet
                }
            });
        } else {
            // Новий користувач - створюємо запис
            const newUser = await pool.query(
                `INSERT INTO telegram_users (telegram_id, username, first_name, last_name, photo_url)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [telegramId, authData.username, authData.first_name, authData.last_name, authData.photo_url]
            );
            
            res.json({
                success: true,
                user: {
                    telegram_id: newUser.rows[0].telegram_id,
                    cabinet: null,
                    first_name: authData.first_name,
                    username: authData.username,
                    photo_url: authData.photo_url,
                    has_cabinet: false
                }
            });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Прив'язка Telegram користувача до кабінету
app.post('/api/telegram/bind-cabinet', async (req, res) => {
    const { telegram_id, cabinet } = req.body;
    
    try {
        // Перевіряємо чи кабінет вже не зайнятий
        const existingResult = await pool.query(
            'SELECT * FROM telegram_users WHERE cabinet = $1 AND telegram_id != $2',
            [cabinet, telegram_id]
        );
        
        if (existingResult.rows.length > 0) {
            return res.status(400).json({ 
                error: 'Цей кабінет вже прив\'язаний до іншого користувача' 
            });
        }
        
        // Прив'язуємо кабінет
        await pool.query(
            'UPDATE telegram_users SET cabinet = $1, updated_at = NOW() WHERE telegram_id = $2',
            [cabinet, telegram_id]
        );
        
        res.json({ success: true, cabinet });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Отримати всіх Telegram користувачів (для адмін панелі)
app.get('/api/telegram/users', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT telegram_id, cabinet, username, first_name, last_name, created_at FROM telegram_users ORDER BY created_at DESC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// SERVER START
// ============================================

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущено на http://localhost:${PORT}`);
});
