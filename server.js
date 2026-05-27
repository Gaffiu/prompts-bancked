require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { Resend } = require('resend');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// Configurações
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'segredo_super_secreto_2026';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Inicializar clientes
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const resend = new Resend(RESEND_API_KEY);

// ==================== ROTAS PÚBLICAS ====================

// Listar todos os produtos
app.get('/api/products', async (req, res) => {
  try {
    const { data, error } = await supabase.from('products').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Buscar produto por ID
app.get('/api/products/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('products').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cadastro de afiliado
app.post('/api/affiliates', async (req, res) => {
  try {
    const { nome, email, pix_key } = req.body;
    if (!nome || !email || !pix_key) return res.status(400).json({ error: 'Campos obrigatórios: nome, email, pix_key' });

    // Gerar link_code único
    const link_code = crypto.randomBytes(4).toString('hex');

    const { data, error } = await supabase.from('affiliates').insert([
      { nome, email, pix_key, link_code }
    ]).select().single();

    if (error) throw error;
    res.json({ message: 'Afiliado cadastrado com sucesso!', link: `https://seudominio.com/?aff=${link_code}`, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Criar pagamento Pix
app.post('/api/create-payment', async (req, res) => {
  try {
    const { items, email, affiliate_code } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Carrinho vazio' });
    }

    // Calcular total: R$1,00 por prompt
    const totalAmount = items.length; // Cada prompt custa R$1,00

    // Buscar afiliado se houver código
    let affiliate = null;
    if (affiliate_code) {
      const { data: affData, error: affError } = await supabase
        .from('affiliates')
        .select('*')
        .eq('link_code', affiliate_code)
        .single();
      if (!affError && affData) affiliate = affData;
    }

    // Criar pagamento no Mercado Pago
    const payment = new Payment(mpClient);
    const body = {
      transaction_amount: totalAmount,
      description: `Compra de ${items.length} prompts`,
      payment_method_id: 'pix',
      payer: {
        email: email || 'cliente@anonimo.com',
      },
      metadata: {
        items: JSON.stringify(items),
        affiliate_code: affiliate_code || null,
      },
    };

    // Se houver afiliado, configurar split de pagamento
    if (affiliate) {
      body.marketplace = 'marketplace';
      body.application_fee = Math.round(totalAmount * 0.3); // 30% comissão
    }

    const result = await payment.create({ body });

    // Salvar pedido no banco
    const { error: orderError } = await supabase.from('orders').insert([
      {
        payment_id: result.id.toString(),
        status: 'pending',
        items: JSON.stringify(items),
        customer_email: email || null,
        affiliate_id: affiliate?.link_code || null,
      }
    ]);

    if (orderError) console.error('Erro ao salvar pedido:', orderError);

    res.json({
      qr_code: result.point_of_interaction?.transaction_data?.qr_code,
      qr_code_base64: result.point_of_interaction?.transaction_data?.qr_code_base64,
      payment_id: result.id,
      pix_copy_paste: result.point_of_interaction?.transaction_data?.qr_code,
    });
  } catch (err) {
    console.error('Erro ao criar pagamento:', err);
    res.status(500).json({ error: err.message || 'Erro ao criar pagamento' });
  }
});

// Verificar status do pagamento
app.get('/api/payment-status/:payment_id', async (req, res) => {
  try {
    const payment = new Payment(mpClient);
    const result = await payment.get({ id: req.params.payment_id });
    
    // Se aprovado, atualizar pedido e retornar prompts
    if (result.status === 'approved') {
      const { data: order, error } = await supabase
        .from('orders')
        .update({ status: 'approved' })
        .eq('payment_id', req.params.payment_id)
        .select()
        .single();

      if (!error && order) {
        // Enviar e-mail se houver endereço
        if (order.customer_email) {
          try {
            const itemsParsed = JSON.parse(order.items);
            const promptText = itemsParsed.map(item => `• ${item.nome}: ${item.prompt}`).join('\n\n');
            await resend.emails.send({
              from: 'PromptXtreme <noreply@seudominio.com>',
              to: order.customer_email,
              subject: 'Seus prompts comprados!',
              text: `Aqui estão seus prompts:\n\n${promptText}\n\nObrigado pela compra!`,
            });
          } catch (emailErr) {
            console.error('Erro ao enviar e-mail:', emailErr);
          }
        }

        return res.json({ 
          status: 'approved', 
          prompts: JSON.parse(order.items),
          message: 'Pagamento aprovado!'
        });
      }
    }

    res.json({ status: result.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook do Mercado Pago (configurar no painel do MP)
app.post('/api/webhook', async (req, res) => {
  try {
    const { action, data } = req.body;
    if (action === 'payment.updated' && data?.id) {
      const payment = new Payment(mpClient);
      const result = await payment.get({ id: data.id });
      
      if (result.status === 'approved') {
        const { data: order, error } = await supabase
          .from('orders')
          .update({ status: 'approved' })
          .eq('payment_id', data.id)
          .select()
          .single();

        if (!error && order && order.customer_email) {
          const itemsParsed = JSON.parse(order.items);
          const promptText = itemsParsed.map(item => `• ${item.nome}: ${item.prompt}`).join('\n\n');
          await resend.emails.send({
            from: 'PromptXtreme <noreply@seudominio.com>',
            to: order.customer_email,
            subject: 'Seus prompts comprados!',
            text: `Aqui estão seus prompts:\n\n${promptText}\n\nObrigado pela compra!`,
          });
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Erro no webhook:', err);
    res.sendStatus(500);
  }
});

// ==================== ROTAS ADMIN (protegidas) ====================

// Middleware de autenticação admin
function authAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') throw new Error();
    next();
  } catch (err) {
    res.status(403).json({ error: 'Acesso negado' });
  }
}

// Login admin
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Senha incorreta' });
});

// Adicionar produto
app.post('/api/admin/products', authAdmin, async (req, res) => {
  try {
    const { nome, categoria, imagem, prompt } = req.body;
    const { data, error } = await supabase.from('products').insert([
      { nome, categoria, imagem, prompt }
    ]).select();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Editar produto
app.put('/api/admin/products/:id', authAdmin, async (req, res) => {
  try {
    const { nome, categoria, imagem, prompt } = req.body;
    const { data, error } = await supabase.from('products')
      .update({ nome, categoria, imagem, prompt })
      .eq('id', req.params.id)
      .select();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remover produto
app.delete('/api/admin/products/:id', authAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('products').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listar pedidos
app.get('/api/admin/orders', authAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listar afiliados
app.get('/api/admin/affiliates', authAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('affiliates').select('*');
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== INICIAR SERVIDOR ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Backend rodando na porta ${PORT}`);
});
