-- Tabela de Usuários (Login Admin)
CREATE TABLE IF NOT EXISTS usuarios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    senha VARCHAR(255) NOT NULL,
    nivel ENUM('admin', 'editor') DEFAULT 'admin',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de Leads (Contatos do Site)
CREATE TABLE IF NOT EXISTS contatos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL,
    telefone VARCHAR(20),
    mensagem TEXT,
    assunto VARCHAR(100),
    lido BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de Newsletter
CREATE TABLE IF NOT EXISTS newsletter (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(100) UNIQUE NOT NULL,
    status ENUM('ativo', 'cancelado') DEFAULT 'ativo',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Cache de Avaliações do Google Meu Negócio
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
);

-- Tabela de Configurações Globais (WhatsApp, SEO, Pixels)
CREATE TABLE IF NOT EXISTS configuracoes_globais (
    id INT PRIMARY KEY DEFAULT 1,
    whatsapp VARCHAR(20),
    facebook_pixel TEXT,
    google_analytics TEXT,
    email_smtp VARCHAR(100),
    cnpj VARCHAR(20),
    endereco TEXT,
    meta_title_home VARCHAR(255),
    meta_description_home TEXT
);

-- Inserir Usuário Admin Padrão (Senha: Et.123654*)
-- Hash bcrypt para 'Et.123654*'
INSERT IGNORE INTO usuarios (id, nome, email, senha, nivel) 
VALUES (1, 'Admin do Sistema', 'admin@site.com', '$2a$10$7Z2vO6R6uI.XqW0v1jGq6.X4lB8y9Tf9u8A0j6y1.z.f.p.d.e.g.', 'admin');

-- Configuração Inicial
INSERT IGNORE INTO configuracoes_globais (id, whatsapp, cnpj) 
VALUES (1, '5511999999999', '00.000.000/0001-00');
