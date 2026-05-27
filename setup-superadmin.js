const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
require('dotenv').config();

async function setup() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'logistica01'
    });

    try {
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash('ET.2026*', salt);

        console.log('⏳ Provisionando SUPER ADMIN...');
        
        // Remove se existir e cria
        await connection.query('DELETE FROM usuarios WHERE email = "superadmin@site.com"');
        await connection.query('INSERT INTO usuarios (nome, email, senha, nivel) VALUES (?, ?, ?, ?)', 
            ['Super Admin', 'superadmin@site.com', hash, 'superadmin']
        );

        console.log('✅ SUPER ADMIN CRIADO COM SUCESSO!');
        console.log('👉 E-mail: superadmin@site.com');
        console.log('👉 Senha: ET.2026*');
        console.log('🚀 Agora você poderá ver a aba de Licenciamento!');
        process.exit(0);
    } catch (err) {
        console.error('❌ ERRO:', err.message);
        process.exit(1);
    }
}

setup();
