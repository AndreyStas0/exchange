// ============================================
// КОД ДЛЯ ДОДАВАННЯ В server.js
// ============================================

// ДОДАТИ В .env:
// TELEGRAM_BOT_TOKEN=your_bot_token_here
// TELEGRAM_CHANNEL_ID=-1001234567890

// ДОДАТИ НА ПОЧАТКУ ФАЙЛУ (після require('dotenv').config()):
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// Функція відправки повідомлення в Telegram
async function sendTelegramNotification(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
        console.log('⚠️ Telegram not configured');
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
            console.error('Telegram API error:', await response.text());
        }
    } catch (err) {
        console.error('Error sending Telegram notification:', err);
    }
}

// Функція отримання IP адреси
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0].trim() || 
           req.headers['x-real-ip'] || 
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           'unknown';
}

// ============================================
// ЗАМІНИТИ ENDPOINT /api/auth/login НА ЦЕЙ:
// ============================================

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
            
            // Перевіряємо чи є активна сесія
            const existingSession = await pool.query(
                'SELECT * FROM sessions WHERE cabinet = $1',
                [cabinet]
            );
            
            if (existingSession.rows.length > 0) {
                // Вже є активна сесія - відмовляємо
                await pool.query(
                    `INSERT INTO login_logs (cabinet, ip_address, user_agent, status)
                     VALUES ($1, $2, $3, $4)`,
                    [cabinet, ipAddress, userAgent, 'rejected_session_exists']
                );
                
                return res.json({
                    success: false,
                    error: 'Цей кабінет вже використовується іншим користувачем'
                });
            }
            
            // Перевіряємо останній вхід з іншого IP
            const lastLogin = await pool.query(
                `SELECT ip_address FROM login_logs 
                 WHERE cabinet = $1 AND status = 'success' 
                 ORDER BY created_at DESC LIMIT 1`,
                [cabinet]
            );
            
            let ipChanged = false;
            if (lastLogin.rows.length > 0 && lastLogin.rows[0].ip_address !== ipAddress) {
                ipChanged = true;
                
                // Відправляємо повідомлення в Telegram
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
            
            // Оновлюємо час останнього використання ключа
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
            // Невірний ключ
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

// ============================================
// ДОДАТИ НОВІ ENDPOINTS:
// ============================================

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

// Примусове завершення сесії (для адміна)
app.post('/api/admin/force-logout/:cabinet', async (req, res) => {
    const { cabinet } = req.params;
    
    try {
        await pool.query('DELETE FROM sessions WHERE cabinet = $1', [cabinet]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Помилка' });
    }
});

// Очищення старих сесій (запускати раз на годину)
setInterval(async () => {
    try {
        // Видаляємо сесії неактивні більше 1 години
        await pool.query(
            `DELETE FROM sessions WHERE last_activity < NOW() - INTERVAL '1 hour'`
        );
    } catch (err) {
        console.error('Error cleaning sessions:', err);
    }
}, 3600000); // Кожну годину
