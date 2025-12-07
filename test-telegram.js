// test-telegram.js - Тест відправки повідомлення в Telegram
require('dotenv').config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

async function testTelegram() {
    console.log('🤖 Тестування Telegram бота...\n');
    
    console.log('Token:', TELEGRAM_BOT_TOKEN ? '✅ Знайдено' : '❌ Не знайдено');
    console.log('Channel ID:', TELEGRAM_CHANNEL_ID ? '✅ Знайдено' : '❌ Не знайдено');
    
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
        console.log('\n❌ Будь ласка, додайте TELEGRAM_BOT_TOKEN та TELEGRAM_CHANNEL_ID в .env файл');
        process.exit(1);
    }
    
    console.log('\n📤 Відправка тестового повідомлення...\n');
    
    const message = `
🧪 <b>ТЕСТОВЕ ПОВІДОМЛЕННЯ</b>

✅ Telegram бот успішно налаштований!
🕐 Час: ${new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' })}

Якщо ви бачите це повідомлення - все працює правильно! 🎉
    `.trim();
    
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
        
        const data = await response.json();
        
        if (data.ok) {
            console.log('✅ Повідомлення успішно відправлено!');
            console.log('📱 Перевірте ваш Telegram канал\n');
        } else {
            console.log('❌ Помилка:', data.description);
            
            if (data.description.includes('bot was blocked')) {
                console.log('💡 Рішення: Переконайтесь що бот доданий в канал як адміністратор');
            } else if (data.description.includes('chat not found')) {
                console.log('💡 Рішення: Перевірте TELEGRAM_CHANNEL_ID (має починатись з -100)');
            } else if (data.description.includes('Unauthorized')) {
                console.log('💡 Рішення: Перевірте TELEGRAM_BOT_TOKEN');
            }
            console.log('');
        }
    } catch (err) {
        console.log('❌ Помилка підключення:', err.message);
        console.log('💡 Перевірте інтернет з\'єднання\n');
    }
}

testTelegram();
