const pool = require('./config/db');
const bcrypt = require('bcryptjs');

async function transform() {
    try {
        console.log('--- INICIANDO TRANSFORMAÇÃO PARA ADVOCACIA ---');

        // 1. Atualizar Configurações Globais
        const settings = {
            site_name: 'MARTINS & ASSOCIADOS',
            home_hero_title: 'Excelência Jurídica em cada <em>Detalhe</em>.',
            home_hero_description: 'Defendendo seus direitos com estratégia, ética e resultados sólidos. Consultoria e assessoria jurídica premium.',
            about_title: 'Tradição e Inovação na <em>Prática Jurídica</em>.',
            about_text: 'Nosso escritório combina décadas de experiência com uma visão moderna do direito, oferecendo soluções personalizadas para questões complexas e acompanhamento rigoroso de cada caso.',
            services_section_title: 'Nossas <em>Áreas de Atuação</em>',
            services_section_text: 'Oferecemos assessoria jurídica completa, atuando de forma preventiva e contenciosa em diversas especialidades do direito.',
            benefits_title: 'Por que <em>nos escolher</em>',
            benefits_text: 'Compromisso inabalável com a justiça, transparência absoluta e foco total no sucesso e na segurança jurídica de nossos clientes.',
            home_hero_card_title: 'Justiça em <em>Foco</em>.',
            home_hero_card_subtitle: 'Defesa Estratégica',
            home_about_button_text: 'Conhecer o Escritório',
            home_services_button_text: 'Ver Áreas de Atuação',
            nav_cta_text: 'Falar com Advogado',
            newsletter_section_title: 'Atualize sua <em>Consciência Jurídica</em>.',
            newsletter_section_text: 'Receba análises exclusivas sobre as mudanças nas leis e como elas impactam sua vida ou empresa.',
            footer_text: '© 2026 Martins & Associados. Todos os direitos reservados. Advocacia de Alto Padrão.',
            footer_short_text: 'Defesa estratégica e consultoria jurídica de alta performance.',
            contact_form_title: 'Agende uma Consulta',
            meta_title_home: 'Martins & Associados | Advocacia de Alto Padrão',
            meta_description_home: 'Escritório de advocacia especializado em direito empresarial, civil e trabalhista. Defesa estratégica e resultados sólidos.',
            color_marinho: '#1A2A3A', // Um azul marinho mais sóbrio para advocacia
            color_vermelho: '#8B0000', // Um bordô elegante
        };

        const sets = Object.keys(settings).map(key => `\`${key}\` = ?`).join(', ');
        const values = Object.values(settings);
        await pool.execute(`UPDATE configuracoes_globais SET ${sets} WHERE id = 1`, values);
        console.log('✅ Configurações globais atualizadas.');

        // 2. Limpar e Inserir Novos Serviços
        await pool.execute('DELETE FROM servicos');
        const services = [
            ['direito-empresarial', 'Direito Empresarial', 'Assessoria completa para empresas, desde a fundação até fusões, aquisições e conformidade regulatória.', 'https://images.unsplash.com/photo-1450101499163-c8848c66ca85?auto=format&fit=crop&q=80&w=800', 'ri-briefcase-line', '<h3>Estratégia para o seu Negócio</h3><p>O Direito Empresarial moderno exige agilidade e visão de futuro. Atuamos na blindagem patrimonial, contratos complexos e resolução de conflitos societários.</p>'],
            ['direito-civil', 'Direito Civil', 'Resolução de conflitos contratuais, responsabilidade civil, direitos de propriedade e relações de consumo.', 'https://images.unsplash.com/photo-1589829545856-d10d557cf95f?auto=format&fit=crop&q=80&w=800', 'ri-scales-3-line', '<h3>Proteção aos seus Direitos</h3><p>Nossa equipe atua em todas as esferas do Direito Civil, garantindo que seus interesses sejam preservados em acordos ou disputas judiciais.</p>'],
            ['direito-do-trabalho', 'Direito do Trabalho', 'Defesa dos interesses corporativos em relações laborais, compliance trabalhista e gestão de passivos.', 'https://images.unsplash.com/photo-1521791136064-7986c2923216?auto=format&fit=crop&q=80&w=800', 'ri-auction-line', '<h3>Relações de Trabalho Seguras</h3><p>Prevenimos riscos trabalhistas através de auditorias e consultoria estratégica, além de atuação forte em processos judiciais de alta complexidade.</p>'],
            ['direito-de-familia', 'Direito de Família', 'Gestão sensível de divórcios, partilha de bens, inventários e planejamento sucessório.', 'https://images.unsplash.com/photo-1591115765373-520b7a21769b?auto=format&fit=crop&q=80&w=800', 'ri-heart-line', '<h3>Soluções Humanizadas</h3><p>Entendemos que questões familiares exigem um olhar empático aliado ao rigor jurídico necessário para proteger o patrimônio e o bem-estar dos envolvidos.</p>']
        ];
        for (const s of services) {
            await pool.execute('INSERT INTO servicos (slug, titulo, resumo, imagem, icone, conteudo, ativo) VALUES (?, ?, ?, ?, ?, ?, 1)', s);
        }
        console.log('✅ Serviços atualizados.');

        // 3. Limpar e Inserir Novos Benefícios (Diferenciais)
        await pool.execute('DELETE FROM beneficios');
        const benefits = [
            ['ri-shield-check-line', 'Ética Inabalável', 'Atuação pautada pelo mais rigoroso código de conduta e transparência total com o cliente.'],
            ['ri-focus-3-line', 'Foco em Resultados', 'Buscamos sempre a solução mais eficiente, seja pela via conciliatória ou judicial.'],
            ['ri-group-line', 'Equipe Especialista', 'Advogados pós-graduados e com vasta experiência em suas respectivas áreas de atuação.'],
            ['ri-customer-service-2-line', 'Atendimento Premium', 'Canal direto com os sócios e acompanhamento em tempo real de cada movimentação do processo.']
        ];
        for (let i = 0; i < benefits.length; i++) {
            await pool.execute('INSERT INTO beneficios (icone, titulo, texto, ordem) VALUES (?, ?, ?, ?)', [...benefits[i], i]);
        }
        console.log('✅ Diferenciais atualizados.');

        // 4. Limpar e Inserir Novos Posts
        await pool.execute('DELETE FROM posts');
        const posts = [
            ['tendencias-direito-digital-2026', 'Tendências do Direito Digital para 2026', 'Tecnologia', '10 Mai 2026', 'Como a IA e as novas regulamentações de dados estão transformando a proteção jurídica online.', 'https://images.unsplash.com/photo-1504384308090-c894fdcc538d?auto=format&fit=crop&q=80&w=800', '<h3>O Futuro é Digital</h3><p>As leis brasileiras estão se adaptando rapidamente à revolução tecnológica. Entenda como se proteger.</p>'],
            ['planejamento-sucessorio-blindagem', 'Planejamento Sucessório e Blindagem Patrimonial', 'Patrimonial', '08 Mai 2026', 'A importância de estruturar a sucessão para evitar conflitos familiares e perdas tributárias.', 'https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?auto=format&fit=crop&q=80&w=800', '<h3>Proteja seu Legado</h3><p>Organizar o patrimônio em vida é a melhor forma de garantir a tranquilidade das próximas gerações.</p>']
        ];
        for (const p of posts) {
            await pool.execute('INSERT INTO posts (slug, titulo, categoria, data, resumo, imagem, conteudo, ativo) VALUES (?, ?, ?, ?, ?, ?, ?, 1)', p);
        }
        console.log('✅ Posts do blog atualizados.');

        // 5. Atualizar Nome do Admin (Opcional mas recomendado)
        await pool.execute("UPDATE usuarios SET nome = 'Admin Advocacia' WHERE id = 1");
        console.log('✅ Nome do usuário admin atualizado.');

        console.log('--- TRANSFORMAÇÃO CONCLUÍDA COM SUCESSO ---');
        process.exit(0);
    } catch (err) {
        console.error('❌ ERRO NA TRANSFORMAÇÃO:', err);
        process.exit(1);
    }
}

transform();
