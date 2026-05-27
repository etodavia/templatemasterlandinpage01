const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
dotenv.config();

async function seed() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'logistica01',
        port: parseInt(process.env.DB_PORT) || 3306
    });

    console.log('🌱 Iniciando Seeding de Métricas...');

    // Limpar dados de teste anteriores se necessário (opcional)
    // await pool.execute('DELETE FROM contatos');
    // await pool.execute('DELETE FROM newsletter');

    const months = [
        { name: 'Jan', num: '01', count: 12 },
        { name: 'Feb', num: '02', count: 18 },
        { name: 'Mar', num: '03', count: 14 },
        { name: 'Apr', num: '04', count: 25 },
        { name: 'May', num: '05', count: 22 }
    ];

    for (const m of months) {
        console.log(`Injecting ${m.count} records for ${m.name}...`);
        for (let i = 0; i < m.count; i++) {
            const isNewsletter = Math.random() > 0.5;
            const date = `2026-${m.num}-${Math.floor(Math.random() * 28) + 1} ${Math.floor(Math.random() * 23)}:${Math.floor(Math.random() * 59)}:00`;
            
            if (isNewsletter) {
                await pool.execute(
                    'INSERT INTO newsletter (email, created_at) VALUES (?, ?)',
                    [`user${Math.random().toString(36).substring(7)}@exemplo.com`, date]
                );
            } else {
                await pool.execute(
                    'INSERT INTO contatos (nome, email, telefone, mensagem, created_at) VALUES (?, ?, ?, ?, ?)',
                    ['Lead Realista', `lead${Math.random().toString(36).substring(7)}@teste.com`, '1199999999', 'Interesse em consultoria', date]
                );
            }
        }
    }

    console.log('✅ Seeding concluído com sucesso!');
    process.exit(0);
}

seed().catch(err => {
    console.error('❌ Erro no Seeding:', err);
    process.exit(1);
});
