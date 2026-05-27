const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

async function setup() {
    // Conecta sem especificar banco de dados primeiro
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '',
        port: process.env.DB_PORT || 3306,
        multipleStatements: true
    });

    try {
        console.log('⏳ Criando banco de dados e tabelas...');
        const sql = fs.readFileSync(path.join(__dirname, 'database', 'schema.sql'), 'utf8');
        
        await connection.query(`CREATE DATABASE IF NOT EXISTS ${process.env.DB_NAME || 'logistica01'};`);
        await connection.query(`USE ${process.env.DB_NAME || 'logistica01'};`);
        await connection.query(sql);

        console.log('✅ DATABASE PRONTA!');
        console.log('🚀 Agora você pode usar o banco configurado em DB_NAME.');
        process.exit(0);
    } catch (err) {
        console.error('❌ ERRO NO SETUP:', err.message);
        process.exit(1);
    }
}

setup();
