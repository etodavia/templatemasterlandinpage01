const pool = require('./config/db');

async function testUpdate() {
    try {
        console.log('1. Fetching current settings...');
        const [rows] = await pool.execute('SELECT * FROM configuracoes_globais WHERE id = 1');
        const settings = rows[0];
        console.log('✅ Current settings columns count:', Object.keys(settings).length);
        
        // Let's test a simple update of a single column
        console.log('2. Testing simple update of site_name...');
        await pool.execute('UPDATE configuracoes_globais SET site_name = ? WHERE id = 1', [settings.site_name || 'ARQUÊ GESTÃO']);
        console.log('✅ Simple update successful!');
        
        // Let's check all columns in the database table
        console.log('3. Fetching table columns...');
        const [columns] = await pool.execute('SHOW COLUMNS FROM configuracoes_globais');
        const dbColumns = columns.map(c => c.Field);
        console.log('✅ DB Columns:', dbColumns);
        
        // Let's check the validColumns whitelist in server.js
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
            'hero_overlay_opacity', 'contact_phone', 'contact_email', 'address_full', 'contact_map_url',
            'contact_form_title', 'contact_form_recipient', 'license_qr_code', 'license_nf_data',
            'license_pdf', 'license_auth_code', 'admin_primary_color', 'admin_accent_color', 'admin_logo', 'admin_header_logo', 'contact_form_fields'
        ];
        
        console.log('4. Checking for missing columns in DB...');
        const missingInDb = validColumns.filter(c => !dbColumns.includes(c));
        console.log('⚠️ Missing in DB:', missingInDb);
        
        process.exit(0);
    } catch (err) {
        console.error('❌ Error during update test:', err);
        process.exit(1);
    }
}

testUpdate();
