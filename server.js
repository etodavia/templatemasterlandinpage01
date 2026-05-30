const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('./config/db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');

dotenv.config();
const ASSET_VERSION = process.env.ASSET_VERSION || require('./package.json').version || '1';
const ALLOWED_UPLOAD_MIMES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    'application/pdf'
]);

function parseCookies(cookieHeader = '') {
    return cookieHeader.split(';').reduce((cookies, pair) => {
        const index = pair.indexOf('=');
        if (index === -1) return cookies;
        const key = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (!key) return cookies;
        try {
            cookies[key] = decodeURIComponent(value);
        } catch (e) {
            cookies[key] = value;
        }
        return cookies;
    }, {});
}

function createRateLimiter({ windowMs, max, message }) {
    const attempts = new Map();
    return (req, res, next) => {
        const now = Date.now();
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const current = attempts.get(ip) || [];
        const recent = current.filter(timestamp => now - timestamp < windowMs);
        if (recent.length >= max) {
            return res.status(429).json({ msg: message });
        }
        recent.push(now);
        attempts.set(ip, recent);
        next();
    };
}

function requireApiAuth(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ msg: 'Autenticacao necessaria.' });
    }
    next();
}

function getTabFromReferer(req) {
    try {
        const referer = req.get('referer');
        if (!referer) return '';
        const url = new URL(referer);
        return url.searchParams.get('tab') || '';
    } catch (e) {
        return '';
    }
}

function cmsRedirect(req, status) {
    const activeTab = req.body?.active_tab || getTabFromReferer(req);
    const params = new URLSearchParams({ [status]: '1' });
    if (activeTab) params.set('tab', activeTab);
    return `/admin/conteudo?${params.toString()}`;
}

const loginRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Muitas tentativas de login. Tente novamente em alguns minutos.'
});
const publicFormRateLimit = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 30,
    message: 'Muitas solicitacoes. Tente novamente em alguns minutos.'
});

const googleReviewRatingMap = {
    ONE: 1,
    TWO: 2,
    THREE: 3,
    FOUR: 4,
    FIVE: 5
};

function googleReviewsConfigured() {
    return Boolean(
        process.env.GOOGLE_BUSINESS_ACCOUNT_ID &&
        process.env.GOOGLE_BUSINESS_LOCATION_ID &&
        process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET &&
        process.env.GOOGLE_REFRESH_TOKEN
    );
}

async function getGoogleAccessToken() {
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
            grant_type: 'refresh_token'
        })
    });

    const data = await response.json();
    if (!response.ok || !data.access_token) {
        throw new Error(data.error_description || data.error || 'Falha ao autenticar no Google.');
    }
    return data.access_token;
}

async function syncGoogleReviews() {
    if (!googleReviewsConfigured()) {
        throw new Error('Configure as variaveis GOOGLE_BUSINESS_* e GOOGLE_* no .env.');
    }

    const token = await getGoogleAccessToken();
    const accountId = encodeURIComponent(process.env.GOOGLE_BUSINESS_ACCOUNT_ID);
    const locationId = encodeURIComponent(process.env.GOOGLE_BUSINESS_LOCATION_ID);
    const pageSize = parseInt(process.env.GOOGLE_REVIEWS_PAGE_SIZE, 10) || 20;
    const minRating = parseInt(process.env.GOOGLE_REVIEWS_MIN_RATING, 10) || 4;
    const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews?pageSize=${pageSize}&orderBy=updateTime desc`;

    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error?.message || 'Falha ao buscar avaliacoes no Google.');
    }

    const reviews = Array.isArray(data.reviews) ? data.reviews : [];
    let saved = 0;
    for (const review of reviews) {
        const rating = googleReviewRatingMap[review.starRating] || 0;
        const text = (review.comment || '').trim();
        if (rating < minRating || !text) continue;

        const reviewer = review.reviewer || {};
        await pool.execute(`
            INSERT INTO google_reviews 
                (review_id, author_name, profile_photo_url, rating, comment, review_url, review_time, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
                author_name = VALUES(author_name),
                profile_photo_url = VALUES(profile_photo_url),
                rating = VALUES(rating),
                comment = VALUES(comment),
                review_url = VALUES(review_url),
                review_time = VALUES(review_time),
                updated_at = NOW()
        `, [
            review.name,
            reviewer.displayName || 'Cliente Google',
            reviewer.profilePhotoUrl || null,
            rating,
            text,
            review.reviewUrl || null,
            review.createTime ? new Date(review.createTime) : null
        ]);
        saved += 1;
    }

    return { received: reviews.length, saved };
}

// Configuração Upload Multer Centralizado
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(dir)){ fs.mkdirSync(dir, { recursive: true }); }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + ext);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 8 * 1024 * 1024, files: 50 },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED_UPLOAD_MIMES.has(file.mimetype)) {
            return cb(new Error('Tipo de arquivo nao permitido.'));
        }
        cb(null, true);
    }
});

// Automação de Migração de Schema (Garantindo novos campos)
async function setupDB() {
    try {
        // Garantir Tabela de Configurações e Registro Raiz
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS configuracoes_globais (
                id INT PRIMARY KEY AUTO_INCREMENT,
                site_name VARCHAR(100) DEFAULT 'Sua Empresa'
            )
        `);
        const [rows] = await pool.execute('SELECT id FROM configuracoes_globais WHERE id = 1');
        if (rows.length === 0) {
            await pool.execute('INSERT INTO configuracoes_globais (id) VALUES (1)');
        }

        const columns = [
            'smtp_host VARCHAR(255)', 'smtp_port INT', 'smtp_user VARCHAR(255)', 'smtp_pass VARCHAR(255)',
            'meta_keywords TEXT', 'pinterest_pixel TEXT', 'linkedin_pixel TEXT', 'custom_head_code TEXT', 'custom_body_code TEXT',
            'email_reply_contact TEXT', 'email_reply_newsletter TEXT', 'email_subject_contact VARCHAR(255)', 'email_subject_newsletter VARCHAR(255)',
            'site_name VARCHAR(100)', 'footer_text TEXT', 'home_hero_title TEXT', 'home_hero_description TEXT', 'services_hero_title TEXT',
            'instagram_url VARCHAR(255)', 'linkedin_url VARCHAR(255)', 'facebook_url VARCHAR(255)', 'nav_cta_text VARCHAR(100)', 'endereco TEXT', 'whatsapp VARCHAR(50)',
            'color_marinho VARCHAR(20) DEFAULT "#0A1128"', 'color_areia VARCHAR(20) DEFAULT "#F7F7F4"', 'color_vermelho VARCHAR(20) DEFAULT "#D62828"', 'color_texto VARCHAR(20) DEFAULT "#333333"',
            'color_header VARCHAR(20) DEFAULT "#FFFFFF"', 'color_footer VARCHAR(20) DEFAULT "#0A1128"',
            'color_header_text VARCHAR(20) DEFAULT "#FFFFFF"', 'color_footer_text VARCHAR(20) DEFAULT "#FFFFFF"',
            'hero_image VARCHAR(255)', 'about_title VARCHAR(255)', 'about_text TEXT', 'about_image VARCHAR(255)', 'benefits_title VARCHAR(255)', 'benefits_text TEXT',
            'about_story_text_left TEXT', 'about_story_text_right TEXT', 'about_mission TEXT', 'about_vision TEXT', 'about_values TEXT', 'about_team_title VARCHAR(255)', 'about_team_text TEXT',
            'about_hero_title VARCHAR(255)', 'about_hero_image VARCHAR(255)', 'services_hero_image VARCHAR(255)', 'blog_hero_title VARCHAR(255)', 'blog_hero_image VARCHAR(255)', 'contact_hero_title VARCHAR(255)', 'contact_hero_image VARCHAR(255)', 'cnpj VARCHAR(50)',
            'logo VARCHAR(255)', 'logo_white VARCHAR(255)', 'favicon VARCHAR(255)', 'show_topbar INT DEFAULT 1', 'footer_secure_link VARCHAR(255)', 'footer_short_text TEXT',
            'services_section_title VARCHAR(255)', 'services_section_text TEXT', 'blog_section_title VARCHAR(255)', 'blog_section_text TEXT', 'testimonial_section_title VARCHAR(255)', 'newsletter_section_title VARCHAR(255)', 'newsletter_section_text TEXT',
            'services_page_description TEXT', 'blog_page_newsletter_title VARCHAR(255)', 'blog_page_newsletter_text TEXT', 'contact_page_description TEXT',
            'site_menu TEXT',
            'home_hero_card_title VARCHAR(255)', 'home_hero_card_subtitle VARCHAR(255)', 'home_about_button_text VARCHAR(100)', 'home_services_button_text VARCHAR(100)',
            'about_story_image VARCHAR(255)', 'social_links TEXT', 'about_story_lead TEXT', 'about_guidelines_title VARCHAR(255)', 'about_guidelines_text TEXT',
            'benefits_items TEXT', 'benefits_template VARCHAR(50)', 'benefits_color VARCHAR(50)', 'benefits_card_title_color VARCHAR(50)', 'benefits_card_text_color VARCHAR(50)', 'benefits_card_bg VARCHAR(50)',
            'hero_overlay_color VARCHAR(50) DEFAULT "#0A1128"', 'hero_overlay_opacity DECIMAL(3,2) DEFAULT 0.40',
            'contact_section_title VARCHAR(255)', 'contact_section_subtitle TEXT',
            'contact_phone VARCHAR(50)', 'contact_email VARCHAR(255)', 'address_full TEXT', 'contact_map_url TEXT',
            'contact_form_title VARCHAR(255)', 'contact_form_recipient VARCHAR(255)',
            'license_qr_code VARCHAR(255)', 'license_nf_data TEXT',
            'license_pdf VARCHAR(255)', 'license_auth_code VARCHAR(255)',
            'template_version VARCHAR(50) DEFAULT "1.0.0"',
            'admin_primary_color VARCHAR(20) DEFAULT "#0A1128"', 'admin_accent_color VARCHAR(20) DEFAULT "#D62828"', 
            'admin_logo VARCHAR(255)', 'admin_header_logo VARCHAR(255)',
            'login_bg_color VARCHAR(20) DEFAULT "#0A1128"', 'login_card_bg VARCHAR(20) DEFAULT "#FFFFFF"', 
            'login_btn_bg VARCHAR(20) DEFAULT "#0A1128"', 'login_btn_text VARCHAR(255) DEFAULT "ACESSAR GOVERNANÇA"',
            'login_label_email VARCHAR(255) DEFAULT "Credencial de Acesso"', 'login_label_password VARCHAR(255) DEFAULT "Assinatura de Segurança"',
            'login_title VARCHAR(255) DEFAULT "Sistema CMS"', 'login_logo VARCHAR(255)',
            'contact_form_fields TEXT', 'header_strip_text TEXT', 'beneficios_json TEXT',
            'benefits_icon_bg VARCHAR(50)', 'benefits_icon_color VARCHAR(50)', 'benefits_title_color VARCHAR(50)', 'benefits_text_color VARCHAR(50)',
            'meta_title_home VARCHAR(255)', 'meta_description_home TEXT', 'facebook_pixel TEXT', 'google_analytics TEXT',
            'license_expiry_date VARCHAR(50)', 'license_stripe_url VARCHAR(512)', 'license_stripe_payment_code VARCHAR(255)',
            'font_title VARCHAR(100) DEFAULT "Playfair Display"', 'font_body VARCHAR(100) DEFAULT "Inter Tight"',
            'color_about_bg VARCHAR(20) DEFAULT "#F7F7F4"', 'color_blog_bg VARCHAR(20) DEFAULT "#0A1128"',
            'color_blog_text VARCHAR(20) DEFAULT "#FFFFFF"', 'color_contact_bg VARCHAR(20) DEFAULT "#F7F7F4"',
            'admin_tutorial_video VARCHAR(500)', 'admin_tutorial_image VARCHAR(500)'
        ];
        for (const col of columns) {
            try {
                await pool.execute(`ALTER TABLE configuracoes_globais ADD COLUMN ${col}`);
                console.log(`✅ DATABASE: Coluna [${col.split(' ')[0]}] provisionada.`);
            } catch (e) { 
                if (e.code !== 'ER_DUP_COLUMN_NAMES' && e.errno !== 1060) {
                    console.error(`❌ DATABASE: Erro ao provisionar coluna [${col.split(' ')[0]}]:`, e.message);
                }
            }
        }
        console.log('✅ DATABASE: Estrutura de Configurações Sincronizada.');

        // Tabelas de Comentários e Depoimentos
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS comentarios (
                id INT AUTO_INCREMENT PRIMARY KEY,
                post_id VARCHAR(255),
                nome VARCHAR(100),
                email VARCHAR(100),
                comentario TEXT,
                aprovado BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS depoimentos (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nome VARCHAR(100),
                cargo VARCHAR(100),
                empresa VARCHAR(100),
                texto TEXT,
                foto VARCHAR(255),
                aprovado BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS google_reviews (
                id INT AUTO_INCREMENT PRIMARY KEY,
                review_id VARCHAR(255) UNIQUE NOT NULL,
                author_name VARCHAR(255),
                profile_photo_url VARCHAR(512),
                rating INT DEFAULT 5,
                comment TEXT,
                review_url VARCHAR(512),
                review_time DATETIME NULL,
                ativo BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS equipe (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nome VARCHAR(255) NOT NULL,
                funcao VARCHAR(255) NOT NULL,
                imagem VARCHAR(255),
                ordem INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS posts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                slug VARCHAR(255) UNIQUE,
                titulo VARCHAR(255),
                categoria VARCHAR(100),
                data VARCHAR(100),
                resumo TEXT,
                imagem VARCHAR(255),
                conteudo LONGTEXT,
                meta_title VARCHAR(255),
                meta_description TEXT,
                destaque_home BOOLEAN DEFAULT FALSE,
                ordem INT DEFAULT 0,
                ativo BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS servicos (
                id INT AUTO_INCREMENT PRIMARY KEY,
                slug VARCHAR(255) UNIQUE,
                titulo VARCHAR(255),
                resumo TEXT,
                imagem VARCHAR(255),
                conteudo LONGTEXT,
                icone VARCHAR(100),
                meta_title VARCHAR(255),
                meta_description TEXT,
                destaque_home BOOLEAN DEFAULT FALSE,
                ordem INT DEFAULT 0,
                ativo BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS beneficios (
                id INT AUTO_INCREMENT PRIMARY KEY,
                icone VARCHAR(100) DEFAULT 'ri-checkbox-circle-line',
                titulo VARCHAR(255),
                texto TEXT,
                ordem INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS newsletter (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(100) UNIQUE NOT NULL,
                status ENUM('ativo', 'cancelado') DEFAULT 'ativo',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        try {
            await pool.execute('ALTER TABLE newsletter ADD COLUMN nome VARCHAR(100) AFTER id');
            console.log('✅ DATABASE: Coluna [nome] adicionada à Newsletter.');
        } catch (e) { /* Coluna já existe */ }

        console.log('✅ DATABASE: Postagens, Serviços e Newsletter (CMS) Prontos.');

        // Tabela de Diferenciais (Substituindo JSON para maior estabilidade)
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS diferenciais (
                id INT AUTO_INCREMENT PRIMARY KEY,
                titulo VARCHAR(255),
                texto TEXT,
                icone VARCHAR(100),
                ordem INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Migração Opcional: Se a tabela diferenciais estiver vazia e houver dados no JSON antigo
        const [difExists] = await pool.execute('SELECT id FROM diferenciais LIMIT 1');
        if (difExists.length === 0) {
            const [rows] = await pool.execute('SELECT benefits_items FROM configuracoes_globais WHERE id = 1');
            if (rows[0] && rows[0].benefits_items) {
                try {
                    const items = JSON.parse(rows[0].benefits_items);
                    for (const item of items) {
                        if (item.title || item.text) {
                            await pool.execute('INSERT INTO diferenciais (titulo, texto, icone) VALUES (?, ?, ?)', 
                                [item.title, item.text, item.icon || 'ri-star-line']);
                        }
                    }
                    console.log('✅ DATABASE: Migração de Diferenciais concluída.');
                } catch(e) { console.error('⚠️ Erro na migração de diferenciais:', e.message); }
            }
        }

        // Inserir Dados Iniciais se estiver vazio
        const [postsExist] = await pool.execute('SELECT id FROM posts LIMIT 1');
        if (postsExist.length === 0) {
            await pool.execute('INSERT INTO posts (slug, titulo, categoria, data, resumo, imagem, conteudo) VALUES ("confianca-capital-psicologico", "Confiança e Capital Psicológico", "Liderança", "05 Abr 2024", "Como a confiança nas organizações impulsiona a inovação e o crescimento.", "https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&q=80&w=800", "<h3>Confiança: A Base da Eficiência</h3><p>Construir um ambiente seguro é o primeiro passo para o sucesso.</p>")');
            console.log('✅ DATABASE: Posts Iniciais Migrados.');
        }

        const seedSv = [
            ['cultura-organizacional', 'Cultura Organizacional', 'Diagnóstico analítico do DNA invisível da sua empresa para alinhar valores e comportamentos reais.', 'https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&q=80&w=800', 'ri-team-line', '<h3>O DNA da sua Empresa</h3><p>A cultura organizacional é o que acontece quando ninguém está olhando. Na Sua Empresa, ajudamos você a mapear os valores reais versus os valores desejados, criando um ambiente que atrai talentos.</p>'],
            ['mentoria-de-lideranca', 'Mentoria de Liderança', 'Capacitação estratégica para gestores transformarem potencial em resultados exponenciais.', 'https://images.unsplash.com/photo-1542744173-8e7e53415bb0?auto=format&fit=crop&q=80&w=800', 'ri-focus-3-line', '<h3>Líderes que Inspiram</h3><p>Liderança não é cargo, é impacto. Nossa mentoria foca em competências comportamentais e inteligência emocional para que seu time atue como verdadeiros parceiros do negócio.</p>'],
            ['gestao-de-processos-rh', 'Gestão de Processos de RH', 'Recrutamento técnico e estruturação de fluxos operacionais com foco em eficiência máxima.', 'https://images.unsplash.com/photo-1507679793137-c72a09c17e64?auto=format&fit=crop&q=80&w=800', 'ri-node-tree', '<h3>Eficiência em cada Contratação</h3><p>Otimizamos todo o ciclo do colaborador, do onboarding ao offboarding. Processos claros reduzem custos e aumentam a clareza para todos os envolvidos.</p>']
        ];
        for(let s of seedSv) {
            await pool.execute('INSERT IGNORE INTO servicos (slug, titulo, resumo, imagem, icone, conteudo) VALUES (?, ?, ?, ?, ?, ?)', s);
        }
        console.log('✅ DATABASE: Portfólio de Especialidades Sincronizado.');

        // Garantir Usuário Admin Padrão
        // Tabela de Usuários (Login Admin) com Nível de Acesso
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nome VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                senha VARCHAR(255) NOT NULL,
                nivel ENUM('superadmin', 'admin') DEFAULT 'admin',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Garantir Coluna Nível e ENUM estendido (superadmin)
        try { 
            await pool.execute("ALTER TABLE usuarios MODIFY COLUMN nivel ENUM('superadmin', 'admin', 'editor') DEFAULT 'admin'");
        } catch(e) {
            try { await pool.execute("ALTER TABLE usuarios ADD COLUMN nivel ENUM('superadmin', 'admin', 'editor') DEFAULT 'admin'"); } catch(err) {}
        }

        // Garantir que SuperAdmin e Admin existam sem sobrescrever senhas alteradas
        const [existingUsers] = await pool.execute('SELECT email FROM usuarios');
        const userEmails = existingUsers.map(u => u.email);

        if (!userEmails.includes('superadmin@etodavia.com')) {
            const hashedSuper = await bcrypt.hash('ET.2026*', 10);
            await pool.execute('INSERT INTO usuarios (nome, email, senha, nivel) VALUES (?, ?, ?, ?)', 
                ['Super Admin ET', 'superadmin@etodavia.com', hashedSuper, 'superadmin']);
        }

        if (!userEmails.includes('admin@agenciaetodavia.com.br')) {
            const hashedAdmin = await bcrypt.hash('123654*', 10);
            await pool.execute('INSERT INTO usuarios (nome, email, senha, nivel) VALUES (?, ?, ?, ?)', 
                ['Vcadmin', 'admin@agenciaetodavia.com.br', hashedAdmin, 'admin']);
        }

        console.log('✅ DATABASE: Usuários (Super/Admin) sincronizados/atualizados.');
    } catch (err) { console.error('❌ DATABASE: Falha na sincronização.', err); }
}
setupDB();

const app = express();

// Security and Parsers
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.locals.assetVersion = ASSET_VERSION;

// EJS Config
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
    etag: true,
    lastModified: true
}));

// MIDDLEWARE DE GOVERNANÇA DE NAVEGAÇÃO (ESTADO ATIVO DOS MENUS)
app.use((req, res, next) => {
    const path = req.path;
    if (path === '/') res.locals.currentPage = 'home';
    else if (path.startsWith('/blog')) res.locals.currentPage = 'blog';
    else if (path.startsWith('/politica')) res.locals.currentPage = 'politica';
    else if (path.startsWith('/termos')) res.locals.currentPage = 'termos';
    else res.locals.currentPage = '';
    next();
});

// ROTA ATUALIZADA PARA INTEGRAR O NOVO HERO (519481.jpg)
app.get('/img/hero_optimo.png', (req, res) => {
    res.sendFile(path.join(__dirname, '519481.jpg'));
});
app.get('/img/logo-agencia.png', (req, res) => {
    const logoPath = path.join(__dirname, 'public', 'img', 'logo-agencia.png');
    if (fs.existsSync(logoPath)) {
        res.sendFile(logoPath);
    } else {
        res.status(404).send('Logo not found');
    }
});

// Middleware de Governança de Acesso (RBAC Industrial via JWT Cookie)
app.use((req, res, next) => {
    let role = null;
    let isAuthenticated = false;
    try {
        const cookies = parseCookies(req.headers.cookie || '');
        const token = cookies.token;
        if (token) {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            role = decoded.user.nivel || 'admin';
            req.user = decoded.user;
            isAuthenticated = true;
        }
    } catch (err) {
        role = null;
        isAuthenticated = false;
    }
    
    res.locals.userRole = role;
    res.locals.isAuthenticated = isAuthenticated;
    res.locals.assetVersion = ASSET_VERSION;

    // Bloqueio rígido para qualquer rota administrativa (/admin) exceto login
    if (req.path.startsWith('/admin') && req.path !== '/admin/login') {
        if (!isAuthenticated) {
            return res.redirect('/admin/login');
        }
    }

    // Se já estiver logado, não há necessidade de ver a tela de login novamente
    if (req.path === '/admin/login' && isAuthenticated) {
        return res.redirect('/admin/dashboard');
    }

    next();
});

// Middleware Global para Configurações (Acessível em todas as Views)
app.use(async (req, res, next) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM configuracoes_globais WHERE id = 1 LIMIT 1');
        const settings = rows[0] || { whatsapp: '5511999999999', cnpj: '00.000.000/0001-00' };
        
        // Verificação de Status da Licença (Carência de 30 dias / Expirada)
        let licenseStatus = 'active'; // active, grace, expired
        let daysOverdue = 0;
        
        if (settings.license_expiry_date) {
            const expiryDate = new Date(settings.license_expiry_date);
            const currentDate = new Date();
            
            // Zerar as horas para comparação correta de datas
            expiryDate.setHours(0, 0, 0, 0);
            currentDate.setHours(0, 0, 0, 0);
            
            if (currentDate > expiryDate) {
                const diffTime = Math.abs(currentDate - expiryDate);
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                daysOverdue = diffDays;
                
                if (diffDays <= 30) {
                    licenseStatus = 'grace'; // Período de carência (1 a 30 dias de atraso)
                } else {
                    licenseStatus = 'expired'; // Suspenso (mais de 30 dias de atraso)
                }
            }
        }
        
        res.locals.settings = settings;
        res.locals.licenseStatus = licenseStatus;
        res.locals.daysOverdue = daysOverdue;
        next();
    } catch (err) {
        res.locals.settings = { whatsapp: '5511999999999', cnpj: '00.000.000/0001-00' };
        res.locals.licenseStatus = 'active';
        res.locals.daysOverdue = 0;
        next();
    }
});

// FRONT-END ROUTES (DATABASE DRIVEN)
app.get('/', async (req, res) => {
    let posts = [];
    let services = [];
    let team = [];
    let testimonials = [];
    let beneficios = [];
    let testimonialSource = 'manual';

    try {
        // Consultar Benefícios
        [beneficios] = await pool.execute('SELECT * FROM beneficios ORDER BY ordem ASC, created_at ASC');

        // Consultar Posts (com fallback)
        try {
            [posts] = await pool.execute('SELECT * FROM posts WHERE destaque_home = 1 AND ativo = 1 ORDER BY ordem ASC, created_at DESC LIMIT 4');
            if (posts.length === 0) [posts] = await pool.execute('SELECT * FROM posts WHERE ativo = 1 ORDER BY created_at DESC LIMIT 4');
        } catch (err) {
            console.warn('⚠️ Fallback Post Query (Missing Columns?):', err.message);
            [posts] = await pool.execute('SELECT * FROM posts ORDER BY created_at DESC LIMIT 4');
        }

        // Consultar Serviços (com fallback)
        try {
            [services] = await pool.execute('SELECT * FROM servicos WHERE destaque_home = 1 AND ativo = 1 ORDER BY ordem ASC, created_at DESC LIMIT 3');
            if (services.length === 0) [services] = await pool.execute('SELECT * FROM servicos WHERE ativo = 1 ORDER BY created_at ASC LIMIT 3');
        } catch (err) {
            console.warn('⚠️ Fallback Service Query (Missing Columns?):', err.message);
            [services] = await pool.execute('SELECT * FROM servicos ORDER BY created_at ASC LIMIT 3');
        }

        // Consultar Equipe e Depoimentos
        [team] = await pool.execute('SELECT * FROM equipe ORDER BY ordem ASC, created_at DESC');
        
        try {
            const [googleReviews] = await pool.execute(`
                SELECT
                    id,
                    author_name AS nome,
                    '' AS cargo,
                    'Google Meu Negocio' AS empresa,
                    comment AS texto,
                    profile_photo_url AS foto,
                    rating,
                    review_url,
                    review_time,
                    'google' AS origem
                FROM google_reviews
                WHERE ativo = TRUE
                ORDER BY review_time DESC, updated_at DESC
                LIMIT 12
            `);
            if (googleReviews.length > 0) {
                testimonials = googleReviews;
                testimonialSource = 'google';
            } else {
                [testimonials] = await pool.execute('SELECT *, NULL AS rating, NULL AS review_url, "manual" AS origem FROM depoimentos WHERE aprovado = TRUE ORDER BY created_at DESC');
            }
        } catch (err) {
            [testimonials] = await pool.execute('SELECT *, NULL AS rating, NULL AS review_url, "manual" AS origem FROM depoimentos ORDER BY created_at DESC');
        }
        
        res.render('index', { 
            title: res.locals.settings?.meta_title_home || 'Sua Empresa | Consultoria Estratégica e Capital Humano', 
            description: res.locals.settings?.meta_description_home || 'Especialistas em impulsionar o capital humano e elevar a performance operacional com visão sistêmica e resultados exponenciais.',
            keywords: res.locals.settings?.meta_keywords || 'gestão, consultoria, rh, capital humano, performance, arquê gestão',
            posts,
            services,
            team,
            testimonials,
            testimonialSource,
            beneficios
        });
    } catch (e) { 
        console.error('❌ CRITICAL HOME ROUTE ERROR:', e);
        res.render('index', { title: 'Home | Sua Empresa', posts: [], services: [], team: [], testimonials: [], beneficios: [] }); 
    }
});

/* Public pages removed: sobre, servicos and service detail.
   These routes are intentionally disabled for the Logistica project.
app.get('/sobre', async (req, res) => {
    try {
        const [team] = await pool.execute('SELECT * FROM equipe ORDER BY ordem ASC, created_at DESC');
        res.render('sobre', { title: 'Sobre | Sua Empresa', team });
    } catch (e) { res.render('sobre', { title: 'Sobre | Sua Empresa', team: [] }); }
});

app.get('/servicos', async (req, res) => {
    try {
        const [services] = await pool.execute('SELECT * FROM servicos WHERE ativo = 1 ORDER BY ordem ASC, titulo ASC');
        res.render('servicos', { title: 'Serviços | Sua Empresa', services });
    } catch (e) { res.render('servicos', { title: 'Serviços | Sua Empresa', services: [] }); }
});

app.get('/servicos/:slug', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM servicos WHERE slug = ? AND ativo = 1', [req.params.slug]);
        const service = rows[0];
        if (!service) return res.redirect('/servicos');
        const [comments] = await pool.execute('SELECT * FROM comentarios WHERE post_id = ? AND aprovado = TRUE', [req.params.slug]);
        res.render('service-detail', { 
            title: service.meta_title || `${service.titulo} | Sua Empresa`, 
            description: service.meta_description || service.resumo,
            service, 
            comments 
        });
    } catch (e) { res.redirect('/servicos'); }
});
*/

// ROTA PÚBLICA PARA COLETAR DEPOIMENTOS
app.get('/colher-depoimento', (req, res) => {
    res.render('public-form-depoimento', { title: 'Compartilhe sua Experiência' });
});

app.post('/api/public-depoimento', upload.single('foto_file'), async (req, res) => {
    const { nome, cargo, empresa, texto } = req.body;
    let foto = '/img/placeholder-user.png';
    if (req.file) foto = `/uploads/${req.file.filename}`;
    
    try {
        await pool.execute(
            'INSERT INTO depoimentos (nome, cargo, empresa, texto, foto, aprovado) VALUES (?, ?, ?, ?, ?, ?)',
            [nome, cargo, empresa, texto, foto, 0] // 0 = Pendente
        );
        res.status(200).json({ success: true });
    } catch (err) {
        console.error('❌ PUBLIC TESTIMONIAL ERROR:', err);
        res.status(500).json({ error: 'Erro ao salvar depoimento' });
    }
});

app.get('/blog', async (req, res) => {
    try {
        const [posts] = await pool.execute('SELECT * FROM posts WHERE ativo = 1 ORDER BY created_at DESC');
        res.render('blog', { title: 'Blog | Sua Empresa', posts });
    } catch (e) { res.render('blog', { title: 'Blog | Sua Empresa', posts: [] }); }
});

app.get('/blog/:slug', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM posts WHERE slug = ?', [req.params.slug]);
        const post = rows[0];
        if (!post) return res.redirect('/blog');
        const [comments] = await pool.execute('SELECT * FROM comentarios WHERE post_id = ? AND aprovado = TRUE ORDER BY created_at DESC', [req.params.slug]);
        res.render('post', { 
            title: post.meta_title || `${post.titulo} | Sua Empresa`, 
            description: post.meta_description || post.resumo,
            post, 
            comments,
            success: req.query.success,
            error: req.query.error
        });
    } catch (e) { res.redirect('/blog'); }
});

// Rota de ativação manual de licença
app.post('/api/licenca/ativar', requireApiAuth, async (req, res) => {
    const { code } = req.body;
    if (!code) {
        return res.status(400).json({ success: false, error: 'Código de ativação é obrigatório.' });
    }

    try {
        const [rows] = await pool.execute('SELECT license_stripe_payment_code FROM configuracoes_globais WHERE id = 1');
        const settings = rows[0] || {};
        
        if (code.trim() === (settings.license_stripe_payment_code || '').trim()) {
            // Estender licença por 1 ano (365 dias) a partir de hoje
            const nextYear = new Date();
            nextYear.setFullYear(nextYear.getFullYear() + 1);
            const expiryDateStr = nextYear.toISOString().split('T')[0];

            await pool.execute('UPDATE configuracoes_globais SET license_expiry_date = ? WHERE id = 1', [expiryDateStr]);
            return res.json({ success: true, expiryDate: expiryDateStr });
        } else {
            return res.status(400).json({ success: false, error: 'Código de pagamento Stripe inválido. Verifique o código e tente novamente.' });
        }
    } catch (e) {
        console.error('Erro ao ativar licença:', e);
        return res.status(500).json({ success: false, error: 'Erro interno ao processar ativação.' });
    }
});

// CMS ADMIN ROUTES
app.get('/admin/conteudo', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM configuracoes_globais WHERE id = 1');
        const settings = rows[0] || {};
        const [beneficios] = await pool.execute('SELECT * FROM beneficios ORDER BY ordem ASC, created_at ASC');
        
        res.render('admin/conteudo', { 
            title: 'Editor Global (CMS)', 
            success: req.query.success,
            error: req.query.error,
            activeTab: req.query.tab || '',
            settings,
            beneficios
        });
    } catch (e) {
        console.error('❌ CMS GET ERROR:', e);
        res.render('admin/conteudo', { title: 'Editor Global (CMS)', settings: {}, beneficios: [] });
    }
});
app.post('/admin/conteudo', upload.fields([
    { name: 'hero_image_file', maxCount: 1 }, 
    { name: 'about_image_file', maxCount: 1 },
    { name: 'about_hero_image_file', maxCount: 1 },
    { name: 'services_hero_image_file', maxCount: 1 },
    { name: 'blog_hero_image_file', maxCount: 1 },
    { name: 'contact_hero_image_file', maxCount: 1 },
    { name: 'about_story_image_file', maxCount: 1 },
    { name: 'logo_file', maxCount: 1 },
    { name: 'logo_white_file', maxCount: 1 },
    { name: 'favicon_file', maxCount: 1 },
    { name: 'license_qr_code_file', maxCount: 1 },
    { name: 'license_pdf_file', maxCount: 1 },
    { name: 'admin_logo_file', maxCount: 1 },
    { name: 'admin_header_logo_file', maxCount: 1 },
    { name: 'login_logo_file', maxCount: 1 },
    { name: 'admin_tutorial_image_file', maxCount: 1 }
]), async (req, res) => {
    let updateData = { ...req.body };
    console.log('📥 REQ.BODY COMPLETO:', Object.keys(req.body));
    
    // Whitelist de colunas válidas no banco para evitar erros de SQL
    const validColumns = [
        'site_name', 'footer_text', 'home_hero_title', 'home_hero_description', 'services_hero_title',
        'instagram_url', 'linkedin_url', 'facebook_url', 'nav_cta_text', 'endereco', 'whatsapp',
        'color_marinho', 'color_areia', 'color_vermelho', 'color_texto', 'color_header', 'color_footer',
        'color_header_text', 'color_footer_text', 'hero_image', 'about_title', 'about_text', 'about_image',
        'about_story_text_left', 'about_story_text_right',
        'about_mission', 'about_vision', 'about_values', 'about_team_title', 'about_team_text',
        'about_hero_title', 'about_hero_image', 'services_hero_image', 'blog_hero_title', 'blog_hero_image',
        'contact_hero_title', 'contact_hero_image', 'cnpj', 'logo', 'logo_white', 'favicon', 'show_topbar',
        'footer_secure_link', 'footer_short_text', 'services_section_title', 'services_section_text',
        'blog_section_title', 'blog_section_text', 'testimonial_section_title', 'newsletter_section_title',
        'newsletter_section_text', 'services_page_description', 'blog_page_newsletter_title',
        'blog_page_newsletter_text', 'contact_page_description', 'site_menu', 'home_hero_card_title',
        'home_hero_card_subtitle', 'home_about_button_text', 'home_services_button_text', 'about_story_image',
        'about_story_lead', 'about_guidelines_title', 'about_guidelines_text',
        'social_links', 'benefits_title', 'benefits_text', 'beneficios_json', 
        'hero_overlay_color',
        'hero_overlay_opacity', 'contact_section_title', 'contact_section_subtitle', 'contact_phone', 'contact_email', 'address_full', 'contact_map_url',
        'contact_form_title', 'contact_form_recipient', 'license_qr_code', 'license_nf_data',
        'license_pdf', 'license_auth_code', 'admin_primary_color', 'admin_accent_color', 'admin_logo', 'admin_header_logo', 'contact_form_fields',
        'login_bg_color', 'login_card_bg', 'login_btn_bg', 'login_btn_text', 'login_label_email', 'login_label_password', 'login_title', 'login_logo',
        'header_strip_text', 'meta_title_home', 'meta_description_home', 'meta_keywords', 'facebook_pixel', 'google_analytics', 'pinterest_pixel', 'linkedin_pixel', 'custom_head_code', 'custom_body_code',
        'license_expiry_date', 'license_stripe_url', 'license_stripe_payment_code', 'template_version',
        'font_title', 'font_body', 'color_about_bg', 'color_blog_bg', 'color_blog_text', 'color_contact_bg',
        'benefits_color', 'benefits_text_color', 'benefits_title_color', 'benefits_icon_bg', 'benefits_icon_color', 'benefits_card_title_color', 'benefits_card_text_color', 'benefits_card_bg',
        'admin_tutorial_video', 'admin_tutorial_image'
    ];

    // Processar Uploads
    const fileFields = [
        'hero_image', 'about_image', 'about_hero_image', 
        'services_hero_image', 'blog_hero_image', 'contact_hero_image',
        'about_story_image', 'logo', 'logo_white', 'favicon', 
        'license_qr_code', 'license_pdf', 'admin_logo', 'admin_header_logo',
        'login_logo', 'admin_tutorial_image'
    ];

    fileFields.forEach(field => {
        const fileKey = field + '_file';
        if(req.files && req.files[fileKey]) {
            updateData[field] = `/uploads/${req.files[fileKey][0].filename}`;
        }
        delete updateData[fileKey];
    });

    // 1. SINCRONIZAÇÃO DA TABELA DE BENEFÍCIOS (Independente do UPDATE principal)
    if (req.body.beneficios_json) {
        try {
            const items = JSON.parse(req.body.beneficios_json);
            console.log(`📦 Sincronizando ${items.length} benefícios...`);
            
            // Usar uma conexão única para garantir a ordem das operações
            const conn = await pool.getConnection();
            try {
                await conn.query('DELETE FROM beneficios');
                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    if (item.icone || item.titulo || item.texto) {
                        await conn.query(
                            'INSERT INTO beneficios (icone, titulo, texto, ordem) VALUES (?, ?, ?, ?)', 
                            [item.icone || 'ri-checkbox-circle-line', item.titulo || '', item.texto || '', i]
                        );
                    }
                }
                console.log('✅ Tabela de benefícios sincronizada.');
            } finally {
                conn.release();
            }
        } catch (err) { 
            console.error('❌ ERRO NA TABELA BENEFICIOS:', err); 
        }
    }

    // 2. FILTRAGEM E UPDATE DAS CONFIGURAÇÕES GLOBAIS
    const filteredData = {};
    validColumns.forEach(key => {
        // Ignoramos beneficios_json que já foi tratado, e só pegamos o que existe no updateData
        if (key !== 'beneficios_json' && updateData[key] !== undefined) {
            let val = updateData[key];
            if (Array.isArray(val)) {
                val = val[0];
            }
            filteredData[key] = val;
        }
    });

    const fields = Object.keys(filteredData);
    console.log('🔍 Campos Finais para SQL:', fields);
    
    if(fields.length === 0) return res.redirect(cmsRedirect(req, 'success'));
    
    const sets = fields.map(f => `\`${f}\` = ?`).join(', ');
    const values = Object.values(filteredData);

    let sql = '';
    try {
        sql = `UPDATE configuracoes_globais SET ${sets} WHERE id = 1`;
        await pool.query(sql, values);
        res.redirect(cmsRedirect(req, 'success'));
    } catch (e) { 
        console.error('❌ CMS UPDATE ERROR:', e);
        res.redirect(cmsRedirect(req, 'error'));
    }
});

app.get('/admin/posts', async (req, res) => {
    const [posts] = await pool.execute('SELECT * FROM posts ORDER BY created_at DESC');
    res.render('admin/manage-posts', { title: 'CMS » Blog', posts });
});
app.get('/admin/posts/novo', (req, res) => res.render('admin/form-post', { title: 'Nova Publicação', post: null }));
app.post('/admin/posts', upload.single('imagem_file'), async (req, res) => {
    const { slug, titulo, categoria, resumo, conteudo, meta_title, meta_description, destaque_home, ordem, ativo } = req.body;
    let imagem = req.body.imagem;
    if (req.file) imagem = `/uploads/${req.file.filename}`;

    const destaque_home_val = (Array.isArray(destaque_home) ? destaque_home.includes('1') : destaque_home === '1') ? 1 : 0;
    const ativo_val = (Array.isArray(ativo) ? ativo.includes('1') : (ativo === '1' || ativo === undefined)) ? 1 : 0;

    try {
        await pool.execute('INSERT INTO posts (slug, titulo, categoria, data, resumo, imagem, conteudo, meta_title, meta_description, destaque_home, ordem, ativo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 
            [slug, titulo, categoria, new Date().toLocaleDateString('pt-BR'), resumo, imagem, conteudo, meta_title, meta_description, destaque_home_val, parseInt(ordem) || 0, ativo_val]);
        res.redirect('/admin/posts?success=1');
    } catch (e) { 
        console.error('❌ POST SAVE ERROR:', e);
        res.redirect('/admin/posts/novo?error=1'); 
    }
});
app.get('/admin/posts/editar/:id', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM posts WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.redirect('/admin/posts');
        res.render('admin/form-post', { title: 'Editar Artigo', post: rows[0] });
    } catch (e) { res.redirect('/admin/posts'); }
});
app.post('/admin/posts/editar/:id', upload.single('imagem_file'), async (req, res) => {
    const { slug, titulo, categoria, resumo, conteudo, meta_title, meta_description, destaque_home, ordem, ativo } = req.body;
    let imagem = req.body.imagem;
    if (req.file) imagem = `/uploads/${req.file.filename}`;

    const destaque_home_val = (Array.isArray(destaque_home) ? destaque_home.includes('1') : destaque_home === '1') ? 1 : 0;
    const ativo_val = (Array.isArray(ativo) ? ativo.includes('1') : (ativo === '1' || ativo === undefined)) ? 1 : 0;

    try {
        await pool.execute('UPDATE posts SET slug=?, titulo=?, categoria=?, resumo=?, imagem=?, conteudo=?, meta_title=?, meta_description=?, destaque_home=?, ordem=?, ativo=? WHERE id=?', 
            [slug, titulo, categoria, resumo, imagem, conteudo, meta_title, meta_description, destaque_home_val, parseInt(ordem) || 0, ativo_val, req.params.id]);
        res.redirect('/admin/posts?success=1');
    } catch (e) { 
        console.error('❌ POST EDIT ERROR:', e);
        res.redirect(`/admin/posts/editar/${req.params.id}?error=1`); 
    }
});
app.post('/admin/posts/delete/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM posts WHERE id = ?', [req.params.id]);
        res.redirect('/admin/posts?success=1');
    } catch (e) { res.redirect('/admin/posts?error=1'); }
});

// CRUD EQUIPE (CAPITAL HUMANO)
app.get('/admin/equipe', async (req, res) => {
    try {
        const [equipe] = await pool.execute('SELECT * FROM equipe ORDER BY ordem ASC, created_at DESC');
        res.render('admin/manage-team', { title: 'Gestão de Equipe', equipe, success: req.query.success });
    } catch (e) { res.send('Erro ao carregar equipe'); }
});
app.get('/admin/equipe/novo', (req, res) => res.render('admin/form-team', { title: 'Novo Membro', member: null }));
app.post('/admin/equipe', upload.single('imagem_file'), async (req, res) => {
    const { nome, funcao, ordem } = req.body;
    let imagem = req.body.imagem || '/img/placeholder-user.png';
    if (req.file) imagem = `/uploads/${req.file.filename}`;
    try {
        await pool.execute('INSERT INTO equipe (nome, funcao, imagem, ordem) VALUES (?, ?, ?, ?)', [nome, funcao, imagem, parseInt(ordem) || 0]);
        res.redirect('/admin/equipe?success=1');
    } catch (e) { 
        console.error('❌ TEAM SAVE ERROR:', e);
        res.redirect('/admin/equipe/novo?error=1'); 
    }
});
app.get('/admin/equipe/editar/:id', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM equipe WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.redirect('/admin/equipe');
        res.render('admin/form-team', { title: 'Editar Membro', member: rows[0] });
    } catch (e) { res.redirect('/admin/equipe'); }
});
app.post('/admin/equipe/editar/:id', upload.single('imagem_file'), async (req, res) => {
    const { nome, funcao, ordem } = req.body;
    let imagem = req.body.imagem;
    if (req.file) imagem = `/uploads/${req.file.filename}`;
    try {
        await pool.execute('UPDATE equipe SET nome=?, funcao=?, imagem=?, ordem=? WHERE id=?', [nome, funcao, imagem, parseInt(ordem) || 0, req.params.id]);
        res.redirect('/admin/equipe?success=1');
    } catch (e) { 
        console.error('❌ TEAM EDIT ERROR:', e);
        res.redirect(`/admin/equipe/editar/${req.params.id}?error=1`); 
    }
});
app.post('/admin/equipe/delete/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM equipe WHERE id = ?', [req.params.id]);
        res.redirect('/admin/equipe?success=1');
    } catch (e) { res.redirect('/admin/equipe?error=1'); }
});

/* Admin: Especialidades (servicos) removed from admin area for Logistica project.
app.get('/admin/servicos', async (req, res) => {
    const [services] = await pool.execute('SELECT * FROM servicos ORDER BY created_at DESC');
    res.render('admin/manage-services', { title: 'CMS » Especialidades', services });
});
app.get('/admin/servicos/novo', (req, res) => res.render('admin/form-service', { title: 'Nova Especialidade', service: null }));
app.post('/admin/servicos', upload.single('imagem_file'), async (req, res) => {
    const { slug, titulo, resumo, conteudo, icone, meta_title, meta_description, destaque_home, ordem, ativo } = req.body;
    let imagem = req.body.imagem;
    if (req.file) imagem = `/uploads/${req.file.filename}`;

    const destaque_home_val = (Array.isArray(destaque_home) ? destaque_home.includes('1') : destaque_home === '1') ? 1 : 0;
    const ativo_val = (Array.isArray(ativo) ? ativo.includes('1') : (ativo === '1' || ativo === undefined)) ? 1 : 0;

    try {
        await pool.execute('INSERT INTO servicos (slug, titulo, resumo, imagem, conteudo, icone, meta_title, meta_description, destaque_home, ordem, ativo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 
            [slug, titulo, resumo, imagem, conteudo, icone, meta_title, meta_description, destaque_home_val, parseInt(ordem) || 0, ativo_val]);
        res.redirect('/admin/servicos?success=1');
    } catch (e) { 
        console.error('❌ SERVICE SAVE ERROR:', e);
        res.redirect('/admin/servicos/novo?error=1'); 
    }
});
app.get('/admin/servicos/editar/:id', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM servicos WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.redirect('/admin/servicos');
        res.render('admin/form-service', { title: 'Editar Especialidade', service: rows[0] });
    } catch (e) { res.redirect('/admin/servicos'); }
});
app.post('/admin/servicos/editar/:id', upload.single('imagem_file'), async (req, res) => {
    const { slug, titulo, resumo, conteudo, icone, meta_title, meta_description, destaque_home, ordem, ativo } = req.body;
    let imagem = req.body.imagem;
    if (req.file) imagem = `/uploads/${req.file.filename}`;

    const destaque_home_val = (Array.isArray(destaque_home) ? destaque_home.includes('1') : destaque_home === '1') ? 1 : 0;
    const ativo_val = (Array.isArray(ativo) ? ativo.includes('1') : (ativo === '1' || ativo === undefined)) ? 1 : 0;

    try {
        await pool.execute('UPDATE servicos SET slug=?, titulo=?, resumo=?, imagem=?, conteudo=?, icone=?, meta_title=?, meta_description=?, destaque_home=?, ordem=?, ativo=? WHERE id=?', 
            [slug, titulo, resumo, imagem, conteudo, icone, meta_title, meta_description, destaque_home_val, parseInt(ordem) || 0, ativo_val, req.params.id]);
        res.redirect('/admin/servicos?success=1');
    } catch (e) { 
        console.error('❌ SERVICE EDIT ERROR:', e);
        res.redirect(`/admin/servicos/editar/${req.params.id}?error=1`); 
    }
});
app.post('/admin/servicos/delete/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM servicos WHERE id = ?', [req.params.id]);
        res.redirect('/admin/servicos?success=1');
    } catch (e) { res.redirect('/admin/servicos?error=1'); }
});
*/
// app.get('/contato', (req, res) => res.render('contato', { title: 'Contato | Sua Empresa' }));
app.get('/politica-de-privacidade', (req, res) => res.render('politica', { title: 'Política de Privacidade | Sua Empresa' }));
app.get('/termos-e-condicoes', (req, res) => res.render('termos', { title: 'Termos e Condições | Sua Empresa' }));

// APIS
app.use('/api/auth/login', loginRateLimit);
app.use(['/api/leads', '/api/newsletter', '/api/depoimentos', '/api/comentarios'], publicFormRateLimit);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/newsletter', require('./routes/newsletter'));

// ADMIN DASHBOARD
app.get('/admin/login', (req, res) => res.render('admin/login', { title: 'Login Admin' }));
app.get('/admin/dashboard', async (req, res) => {
    try {
        const [l] = await pool.execute('SELECT COUNT(*) as n FROM contatos');
        const [n] = await pool.execute('SELECT COUNT(*) as n FROM newsletter');
        
        // Busca conversões dos últimos 6 meses (Leads + Newsletter)
        const [monthlyData] = await pool.execute(`
            SELECT mes, SUM(qtd) as qtd FROM (
                SELECT DATE_FORMAT(created_at, '%b') as mes, DATE_FORMAT(created_at, '%m') as mes_num, COUNT(*) as qtd 
                FROM contatos 
                WHERE created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
                GROUP BY mes, mes_num
                UNION ALL
                SELECT DATE_FORMAT(created_at, '%b') as mes, DATE_FORMAT(created_at, '%m') as mes_num, COUNT(*) as qtd 
                FROM newsletter 
                WHERE created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
                GROUP BY mes, mes_num
            ) as combined
            GROUP BY mes, mes_num
            ORDER BY mes_num ASC
        `);

        res.render('admin/dashboard', { 
            title: 'Dashboard', 
            leads: l[0].n, 
            news: n[0].n, 
            chartData: monthlyData 
        });
    } catch (e) { 
        console.error('❌ DASHBOARD ERROR:', e);
        res.render('admin/dashboard', { title: 'Dashboard', leads: 0, news: 0, chartData: [] }); 
    }
});

app.get('/admin/leads', async (req, res) => {
    try {
        const [leads] = await pool.execute('SELECT * FROM contatos ORDER BY created_at DESC');
        res.render('admin/leads', { title: 'Gestão de Leads', leads });
    } catch (e) { res.send('Erro ao carregar leads'); }
});

app.post('/admin/leads/delete/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM contatos WHERE id = ?', [req.params.id]);
        res.redirect('/admin/leads');
    } catch (e) { res.redirect('/admin/leads'); }
});

app.get('/admin/newsletter', async (req, res) => {
    try {
        const [emails] = await pool.execute('SELECT * FROM newsletter ORDER BY created_at DESC');
        res.render('admin/newsletter', { title: 'Newsletter', emails });
    } catch (e) { res.send('Erro ao carregar newsletter'); }
});

app.post('/admin/newsletter/delete/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM newsletter WHERE id = ?', [req.params.id]);
        res.redirect('/admin/newsletter');
    } catch (e) { res.redirect('/admin/newsletter'); }
});

app.get('/admin/config', async (req, res) => {
    try {
        const [config] = await pool.execute('SELECT * FROM configuracoes_globais LIMIT 1');
        res.render('admin/config', { title: 'Configurações Globais', settings: config[0] || {} });
    } catch (e) { res.render('admin/config', { title: 'Configurações', settings: {} }); }
});

app.post('/admin/config', async (req, res) => {
    const { 
        whatsapp, cnpj, endereco, meta_title_home, meta_description_home, meta_keywords,
        facebook_pixel, google_analytics, pinterest_pixel, linkedin_pixel,
        custom_head_code, custom_body_code, smtp_host, smtp_port, smtp_user, smtp_pass,
        email_reply_contact, email_reply_newsletter, email_subject_contact, email_subject_newsletter
    } = req.body;
    const query = `
        UPDATE configuracoes_globais SET 
        whatsapp = ?, cnpj = ?, endereco = ?, meta_title_home = ?, meta_description_home = ?, meta_keywords = ?,
        facebook_pixel = ?, google_analytics = ?, pinterest_pixel = ?, linkedin_pixel = ?,
        custom_head_code = ?, custom_body_code = ?, smtp_host = ?, smtp_port = ?, smtp_user = ?, smtp_pass = ?,
        email_reply_contact = ?, email_reply_newsletter = ?, email_subject_contact = ?, email_subject_newsletter = ?
        WHERE id = 1
    `;
    try {
        await pool.execute(query, [
            whatsapp, cnpj, endereco, meta_title_home, meta_description_home, meta_keywords,
            facebook_pixel, google_analytics, pinterest_pixel, linkedin_pixel,
            custom_head_code, custom_body_code, smtp_host, parseInt(smtp_port) || null, smtp_user, smtp_pass,
            email_reply_contact, email_reply_newsletter, email_subject_contact, email_subject_newsletter
        ]);
        res.redirect('/admin/config?success=1');
    } catch (e) { 
        console.error('❌ CONFIG SAVE ERROR:', e);
        res.redirect('/admin/config?error=1'); 
    }
});

app.get('/admin/perfil', async (req, res) => {
    try {
        const [user] = await pool.execute('SELECT nome, email FROM usuarios WHERE id = 1');
        const [config] = await pool.execute('SELECT whatsapp FROM configuracoes_globais WHERE id = 1');
        
        // Defesa: Caso o ID 1 tenha sido alterado/removido
        const userData = user[0] || { nome: 'Administrador', email: 'admin@teste.com' };

        res.render('admin/perfil', { 
            title: 'Meu Perfil', 
            user: userData, 
            whatsapp: config[0]?.whatsapp || '',
            success: req.query.success,
            error: req.query.error
        });
    } catch (e) { res.redirect('/admin/dashboard'); }
});

app.post('/admin/perfil', async (req, res) => {
    const { nome, email, senha, whatsapp } = req.body;
    try {
        await pool.execute('UPDATE usuarios SET nome = ?, email = ? WHERE id = 1', [nome, email]);
        if (senha && senha.trim() !== '') {
            const salt = await bcrypt.genSalt(10);
            const hashed = await bcrypt.hash(senha, salt);
            await pool.execute('UPDATE usuarios SET senha = ? WHERE id = 1', [hashed]);
        }
        await pool.execute('UPDATE configuracoes_globais SET whatsapp = ? WHERE id = 1', [whatsapp]);
        res.redirect('/admin/perfil?success=1');
    } catch (e) { res.redirect('/admin/perfil?error=1'); }
});

// GESTÃO DE COMENTÁRIOS (ADMIN)
app.get('/admin/comentarios', async (req, res) => {
    try {
        const [comentarios] = await pool.execute('SELECT * FROM comentarios ORDER BY created_at DESC');
        res.render('admin/comentarios', { title: 'Moderação de Comentários', comentarios });
    } catch (e) { res.redirect('/admin/dashboard'); }
});
app.post('/admin/comentarios/aprovar/:id', async (req, res) => {
    await pool.execute('UPDATE comentarios SET aprovado = TRUE WHERE id = ?', [req.params.id]);
    res.redirect('/admin/comentarios');
});
app.post('/admin/comentarios/delete/:id', async (req, res) => {
    await pool.execute('DELETE FROM comentarios WHERE id = ?', [req.params.id]);
    res.redirect('/admin/comentarios');
});

// GESTÃO DE DEPOIMENTOS (ADMIN)
app.get('/admin/depoimentos', async (req, res) => {
    try {
        const [depoimentos] = await pool.execute('SELECT * FROM depoimentos ORDER BY created_at DESC');
        let googleReviews = [];
        try {
            [googleReviews] = await pool.execute('SELECT * FROM google_reviews ORDER BY review_time DESC, updated_at DESC LIMIT 50');
        } catch (e) {
            googleReviews = [];
        }
        res.render('admin/depoimentos', {
            title: 'Moderação de Depoimentos',
            depoimentos,
            googleReviews,
            googleReviewsConfigured: googleReviewsConfigured(),
            googleSyncSuccess: req.query.google_sync === 'success',
            googleSyncError: req.query.google_sync === 'error' ? req.query.message : null,
            googleSyncSaved: req.query.saved,
            googleSyncReceived: req.query.received
        });
    } catch (e) { res.redirect('/admin/dashboard'); }
});
app.post('/admin/depoimentos/sync-google', async (req, res) => {
    try {
        const result = await syncGoogleReviews();
        res.redirect(`/admin/depoimentos?google_sync=success&saved=${result.saved}&received=${result.received}`);
    } catch (e) {
        console.error('GOOGLE REVIEWS SYNC ERROR:', e.message);
        res.redirect(`/admin/depoimentos?google_sync=error&message=${encodeURIComponent(e.message)}`);
    }
});
app.post('/admin/depoimentos/aprovar/:id', async (req, res) => {
    await pool.execute('UPDATE depoimentos SET aprovado = TRUE WHERE id = ?', [req.params.id]);
    res.redirect('/admin/depoimentos');
});
app.post('/admin/depoimentos/delete/:id', async (req, res) => {
    await pool.execute('DELETE FROM depoimentos WHERE id = ?', [req.params.id]);
    res.redirect('/admin/depoimentos');
});

// FORMULÁRIO EXTERNO DE DEPOIMENTOS (PÚBLICO)
app.get('/depoimentos/novo', (req, res) => {
    res.render('form-depoimento', { title: 'Enviar Depoimento | Sua Empresa' });
});
app.post('/api/depoimentos', upload.single('foto'), async (req, res) => {
    const { nome, cargo, empresa, texto } = req.body;
    const foto = req.file ? `/uploads/${req.file.filename}` : null;
    try {
        await pool.execute('INSERT INTO depoimentos (nome, cargo, empresa, texto, foto) VALUES (?, ?, ?, ?, ?)', [nome, cargo, empresa, texto, foto]);
        res.redirect('/depoimentos/novo?success=1');
    } catch (e) { res.redirect('/depoimentos/novo?error=1'); }
});

// SUBMISSÃO DE COMENTÁRIO (PÚBLICO)
app.post('/api/comentarios', async (req, res) => {
    const { post_id, nome, email, comentario } = req.body;
    try {
        await pool.execute('INSERT INTO comentarios (post_id, nome, email, comentario) VALUES (?, ?, ?, ?)', [post_id, nome, email, comentario]);
        res.redirect(`/blog/${post_id}?success=comment`);
    } catch (e) { res.redirect(`/blog/${post_id}?error=comment`); }
});

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message === 'Tipo de arquivo nao permitido.') {
        const wantsJson = req.xhr || (req.headers.accept || '').includes('application/json');
        if (wantsJson) {
            return res.status(400).json({ msg: err.message });
        }
        if (req.originalUrl && req.originalUrl.startsWith('/admin/conteudo')) {
            return res.redirect(cmsRedirect(req, 'error'));
        }
        return res.redirect(`${req.headers.referer || '/'}?error=upload`);
    }
    next(err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Sistema SISTEMA ON: Porta ${PORT}`));
