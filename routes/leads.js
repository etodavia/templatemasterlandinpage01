const express = require('express');
const router = express.Router();
const pool = require('../config/db');

function requireAuth(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ msg: 'Autenticação necessária.' });
    }
    next();
}

// @route   POST api/leads (Public)
// @desc    Register a new lead
router.post('/', async (req, res) => {
    const { nome, email, telefone, mensagem } = req.body;
    try {
        const query = 'INSERT INTO contatos (nome, email, telefone, mensagem) VALUES (?, ?, ?, ?)';
        await pool.execute(query, [nome, email, telefone, mensagem]);
        res.status(200).json({ msg: 'Contato enviado com sucesso!' });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Erro ao salvar contato.' });
    }
});

// @route   GET api/leads (Admin)
router.get('/', requireAuth, async (req, res) => {
    try {
        // CORREÇÃO: Usando a coluna 'created_at' como no schema.sql
        const [rows] = await pool.execute('SELECT * FROM contatos ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Erro no banco de dados.');
    }
});

module.exports = router;
