// clear-data.js - Скрипт для очищення даних в базі даних
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function clearData() {
    const client = await pool.connect();
    
    try {
        console.log('🧹 Початок очищення даних...');
        
        // Очищуємо всі таблиці (але залишаємо структуру)
        console.log('📦 Очищення таблиць...');
        
        await client.query('DELETE FROM hidden_withdrawals');
        console.log('  ✓ Таблиця hidden_withdrawals очищена');
        
        await client.query('DELETE FROM hidden_orders');
        console.log('  ✓ Таблиця hidden_orders очищена');
        
        await client.query('DELETE FROM withdrawals');
        console.log('  ✓ Таблиця withdrawals очищена');
        
        await client.query('DELETE FROM order_requests');
        console.log('  ✓ Таблиця order_requests очищена');
        
        await client.query('DELETE FROM orders');
        console.log('  ✓ Таблиця orders очищена');
        
        await client.query('DELETE FROM balances');
        console.log('  ✓ Таблиця balances очищена');
        
        // Скидаємо лічильники (SERIAL)
        console.log('\n🔄 Скидання лічильників ID...');
        
        await client.query('ALTER SEQUENCE hidden_withdrawals_id_seq RESTART WITH 1');
        await client.query('ALTER SEQUENCE hidden_orders_id_seq RESTART WITH 1');
        await client.query('ALTER SEQUENCE withdrawals_id_seq RESTART WITH 1');
        await client.query('ALTER SEQUENCE order_requests_id_seq RESTART WITH 1');
        await client.query('ALTER SEQUENCE orders_id_seq RESTART WITH 1');
        await client.query('ALTER SEQUENCE balances_id_seq RESTART WITH 1');
        console.log('  ✓ Лічильники скинуто');
        
        // Ініціалізація всіх зв'язків між кабінетами з балансом 0
        console.log('\n📊 Ініціалізація балансів між кабінетами...');
        const cabinets = [
            'Кабінет 1 UA', 'Кабінет 2 UA', 'Кабінет 3 UA', 'Кабінет 4 UA',
            'Кабінет 1 ARS', 'Кабінет 2 ARS'
        ];
        
        let balanceCount = 0;
        // Створюємо тільки один зв'язок між кожною парою (не дублюємо)
        for (let i = 0; i < cabinets.length; i++) {
            for (let j = i + 1; j < cabinets.length; j++) {
                await client.query(
                    'INSERT INTO balances (cabinet_from, cabinet_to, amount) VALUES ($1, $2, 0)',
                    [cabinets[i], cabinets[j]]
                );
                balanceCount++;
            }
        }
        console.log(`  ✓ Створено ${balanceCount} зв'язків між кабінетами`);
        
        console.log('\n✅ Очищення завершено успішно!');
        console.log('📊 Всі дані видалено, структура збережена');
        console.log('💰 Всі баланси між кабінетами ініціалізовані як 0');
        console.log('🚀 Можна продовжувати роботу');
        
    } catch (err) {
        console.error('❌ Помилка очищення:', err);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

// Підтвердження перед очищенням
console.log('⚠️  УВАГА! Ця операція видалить ВСІ дані з бази даних!');
console.log('📋 Будуть видалені:');
console.log('   - Всі ордери');
console.log('   - Всі запити на ордери');
console.log('   - Всі виводи');
console.log('   - Всі баланси між кабінетами');
console.log('   - Всі приховані записи');
console.log('');

// Перевірка параметра командного рядка
const args = process.argv.slice(2);

if (args.includes('--confirm') || args.includes('-y')) {
    // Запуск з підтвердженням
    clearData();
} else {
    // Інтерактивне підтвердження
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.question('Продовжити? (введіть YES для підтвердження): ', (answer) => {
        if (answer.toUpperCase() === 'YES') {
            rl.close();
            clearData();
        } else {
            console.log('\n❌ Операцію скасовано');
            rl.close();
            process.exit(0);
        }
    });
}
