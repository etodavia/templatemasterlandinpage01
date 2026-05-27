const jwt = require('jsonwebtoken');

module.exports = function(req, res, next) {
    const cookies = (req.headers.cookie || '').split(';').reduce((acc, pair) => {
        const index = pair.indexOf('=');
        if (index === -1) return acc;
        const key = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        try {
            acc[key] = decodeURIComponent(value);
        } catch (e) {
            acc[key] = value;
        }
        return acc;
    }, {});
    const token = req.header('x-auth-token') || cookies.token;

    // Check if not token
    if (!token) {
        return res.status(401).json({ msg: 'Nenhum token, autorização negada.' });
    }

    // Verify token
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded.user;
        next();
    } catch (err) {
        res.status(401).json({ msg: 'Token não é válido.' });
    }
};
