// migrate.js - Скрипт для міграції бази даних
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function migrate() {
    const client = await pool.connect();
    
    try {
        console.log('🔄 Початок міграції бази даних...');
        
        // Видаляємо всі старі таблиці
        console.log('📦 Видалення старих таблиць...');
        await client.query('DROP TABLE IF EXISTS login_logs CASCADE');
        await client.query('DROP TABLE IF EXISTS sessions CASCADE');
        await client.query('DROP TABLE IF EXISTS admin_logs CASCADE');
        await client.query('DROP TABLE IF EXISTS access_keys CASCADE');
        await client.query('DROP TABLE IF EXISTS telegram_users CASCADE');
        await client.query('DROP TABLE IF EXISTS hidden_withdrawals CASCADE');
        await client.query('DROP TABLE IF EXISTS hidden_orders CASCADE');
        await client.query('DROP TABLE IF EXISTS withdrawals CASCADE');
        await client.query('DROP TABLE IF EXISTS order_requests CASCADE');
        await client.query('DROP TABLE IF EXISTS orders CASCADE');
        await client.query('DROP TABLE IF EXISTS balances CASCADE');
        
        console.log('✅ Старі таблиці видалено');
        
        // Створюємо нові таблиці
        console.log('📝 Створення нових таблиць...');
        
        // Таблиця ключів доступу
        await client.query(`
            CREATE TABLE access_keys (
                id SERIAL PRIMARY KEY,
                access_key VARCHAR(10) UNIQUE NOT NULL,
                cabinet VARCHAR(50) NOT NULL,
                description VARCHAR(255),
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_used TIMESTAMP
            )
        `);
        console.log('  ✓ Таблиця access_keys створена');
        
        // Додаємо початкові ключі
        const initialKeys = [
            { key: 'aB3xY9mK2p', cabinet: 'Кабінет 1 UA', desc: 'Ключ для Кабінету 1 UA' },
            { key: 'qW7rT4nL8s', cabinet: 'Кабінет 2 UA', desc: 'Ключ для Кабінету 2 UA' },
            { key: 'zX5cV1bN6m', cabinet: 'Кабінет 3 UA', desc: 'Ключ для Кабінету 3 UA' },
            { key: 'pL9kJ2hG4f', cabinet: 'Кабінет 4 UA', desc: 'Ключ для Кабінету 4 UA' },
            { key: 'mN8vB3xC7q', cabinet: 'Кабінет 1 ARS', desc: 'Ключ для Кабінету 1 ARS' },
            { key: 'rT6yU1wE5a', cabinet: 'Кабінет 2 ARS', desc: 'Ключ для Кабінету 2 ARS' },
            { key: 'AdM1n9PaSs', cabinet: 'ADMIN 1', desc: 'Ключ адміністратора 1' },
            { key: 'AdM2n8QwEr', cabinet: 'ADMIN 2', desc: 'Ключ адміністратора 2' },
            { key: 'AdM3n7AsD', cabinet: 'ADMIN 3', desc: 'Ключ адміністратора 3' }
        ];
        
        for (const item of initialKeys) {
            await client.query(
                'INSERT INTO access_keys (access_key, cabinet, description) VALUES ($1, $2, $3)',
                [item.key, item.cabinet, item.desc]
            );
        }
        console.log('  ✓ Початкові ключі додано (включно з 3 адмін ключами)');
        
        // Таблиця користувачів Telegram
        await client.query(`
            CREATE TABLE telegram_users (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT UNIQUE NOT NULL,
                cabinet VARCHAR(50),
                username VARCHAR(255),
                first_name VARCHAR(255),
                last_name VARCHAR(255),
                photo_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('  ✓ Таблиця telegram_users створена');
        
        // Таблиця балансів (між парами кабінетів)
        await client.query(`
            CREATE TABLE balances (
                id SERIAL PRIMARY KEY,
                cabinet_from VARCHAR(50) NOT NULL,
                cabinet_to VARCHAR(50) NOT NULL,
                amount DECIMAL(10, 2) DEFAULT 0,
                UNIQUE(cabinet_from, cabinet_to)
            )
        `);
        console.log('  ✓ Таблиця balances створена');

        // Таблиця ордерів
        await client.query(`
            CREATE TABLE orders (
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
        console.log('  ✓ Таблиця orders створена');

        // Таблиця запитів на ордери
        await client.query(`
            CREATE TABLE order_requests (
                id SERIAL PRIMARY KEY,
                from_cabinet VARCHAR(50) NOT NULL,
                to_cabinet VARCHAR(50) NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                type VARCHAR(20) NOT NULL,
                remaining_amount DECIMAL(10, 2) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('  ✓ Таблиця order_requests створена');

        // Таблиця виводів
        await client.query(`
            CREATE TABLE withdrawals (
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
        console.log('  ✓ Таблиця withdrawals створена');

        // Таблиця прихованих ордерів
        await client.query(`
            CREATE TABLE hidden_orders (
                id SERIAL PRIMARY KEY,
                cabinet VARCHAR(50) NOT NULL,
                order_id INTEGER NOT NULL,
                UNIQUE(cabinet, order_id)
            )
        `);
        console.log('  ✓ Таблиця hidden_orders створена');

        // Таблиця прихованих виводів
        await client.query(`
            CREATE TABLE hidden_withdrawals (
                id SERIAL PRIMARY KEY,
                cabinet VARCHAR(50) NOT NULL,
                withdrawal_id INTEGER NOT NULL,
                UNIQUE(cabinet, withdrawal_id)
            )
        `);
        console.log('  ✓ Таблиця hidden_withdrawals створена');

        // Таблиця логів адміністратора
        await client.query(`
            CREATE TABLE admin_logs (
                id SERIAL PRIMARY KEY,
                admin_name VARCHAR(50) NOT NULL,
                action_type VARCHAR(50) NOT NULL,
                cabinet VARCHAR(50),
                amount_old DECIMAL(10, 2),
                amount_new DECIMAL(10, 2),
                description TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('  ✓ Таблиця admin_logs створена');

        // Таблиця активних сесій
        await client.query(`
            CREATE TABLE sessions (
                id SERIAL PRIMARY KEY,
                cabinet VARCHAR(50) NOT NULL,
                session_id VARCHAR(255) UNIQUE NOT NULL,
                ip_address VARCHAR(45),
                user_agent TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                last_activity TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('  ✓ Таблиця sessions створена');

        // Таблиця логування входів
        await client.query(`
            CREATE TABLE login_logs (
                id SERIAL PRIMARY KEY,
                cabinet VARCHAR(50) NOT NULL,
                ip_address VARCHAR(45),
                user_agent TEXT,
                status VARCHAR(20),
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('  ✓ Таблиця login_logs створена');

        console.log('\n✅ Міграція завершена успішно!');
        console.log('🚀 Тепер можна запускати сервер: npm start');
        
    } catch (err) {
        console.error('❌ Помилка міграції:', err);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

// Запуск міграції
migrate();
