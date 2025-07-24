require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// Verifica se o diretório de uploads existe, se não, cria
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Configuração do Multer para upload de imagens
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});


// Rota para servir imagens
const upload = multer({ 
    storage: storage,
    limits: { 
        fileSize: 10 * 1024 * 1024, // 10MB
        files: 10 // Limite de 10 arquivos
    }
});

// Middlewares
app.options('*', cors());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());




// Conexão com o MySQL (usando pool de conexões)
const pool = mysql.createPool({
  host: process.env.DB_HOST,          // Host do banco (ex: localhost ou Railway)
  user: process.env.DB_USER,          // Usuário do banco
  password: process.env.DB_PASSWORD,  // Senha do banco
  database: process.env.DB_NAME,      // Nome do banco de dados
  port: process.env.DB_PORT || 3306,  // Porta (usa 3306 se não tiver no .env ou na variaveis da raiway)
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0
});

// Testar conexão com o banco de dados
pool.getConnection()
  .then(conn => {
    console.log('✅ Conexão com MySQL estabelecida com sucesso!🥳🚀');
    conn.release();
  })
  .catch(err => {
    console.error('😓🛑 Erro ao conectar ao MySQL:', err.message);
  });

// Criação das tabelas (executar apenas uma vez)
  async function createTables() {
    try {
      const conn = await pool.getConnection();
      
      // Tabela de ordens de serviço
      await conn.query(`
        CREATE TABLE IF NOT EXISTS ordens_servico (
          id INT AUTO_INCREMENT PRIMARY KEY,
          nome_cliente VARCHAR(100) NOT NULL,
          whatsapp VARCHAR(20) NOT NULL,
          tipo_aparelho VARCHAR(50) NOT NULL,
          marca VARCHAR(50) NOT NULL,
          modelo VARCHAR(50) NOT NULL,
          imei_serial VARCHAR(50),
          relato_cliente TEXT,
          servico_descricao TEXT,
          peca_trocada VARCHAR(100),
          status ENUM('pendente', 'andamento', 'concluido', 'cancelado') DEFAULT 'pendente',
          valor_peca DECIMAL(10,2) DEFAULT 0,
          valor_taxa DECIMAL(10,2) DEFAULT 0,
          valor_total DECIMAL(10,2) DEFAULT 0,
          data_entrada DATE NOT NULL,
          data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Tabela de checklist
      await conn.query(`
        CREATE TABLE IF NOT EXISTS checklist (
          id INT AUTO_INCREMENT PRIMARY KEY,
          ordem_id INT NOT NULL,
          item VARCHAR(255) NOT NULL,
          FOREIGN KEY (ordem_id) REFERENCES ordens_servico(id) ON DELETE CASCADE
        )
      `);
      
      // Tabela de fotos
      await conn.query(`
        CREATE TABLE IF NOT EXISTS fotos (
          id INT AUTO_INCREMENT PRIMARY KEY,
          ordem_id INT NOT NULL,
          caminho VARCHAR(255) NOT NULL,
          FOREIGN KEY (ordem_id) REFERENCES ordens_servico(id) ON DELETE CASCADE
        )
      `);
      
      conn.release();
      console.log('Tabelas criadas com sucesso!');
    } catch (err) {
      console.error('Erro ao criar tabelas:', err);
    }
  }  

//==============================
//        ROTAS DA API
//=============================
app.use('/api/images', express.static(path.join(__dirname, 'uploads')));
// Listar todas as ordens
// Criar nova ordem
app.post('/api/ordens', upload.array('fotos', 10), async (req, res) => {
  try {

    //========Logs para debugar==========
    console.log('Dados recebidos:', req.body);
    console.log('Arquivos recebidos:', req.files);
    
    // Mapeamento de status do frontend para os valores do ENUM
const statusMap = {
    'pendente': 'pendente',
    'andamento': 'andamento',
    'concluido': 'concluido',
    'cancelado': 'cancelado'
};

    const {
      clientName, whatsapp, deviceType, brand, model, imei,
      clientReport, serviceDescription, replacedPart, status,
      partValue, taxValue, totalValue, entryDay, entryMonth, entryYear,
      checklist
    } = req.body;
    
    const checklistArray = typeof checklist === 'string' ? 
      JSON.parse(checklist) : (checklist || []);

    // Converter status para o valor correto do ENUM
    const dbStatus = statusMap[status] || 'pendente';

    // Inserir a ordem principal
    const [result] = await pool.query(
      `INSERT INTO ordens_servico SET ?`, 
      {
        nome_cliente: clientName,
        whatsapp: whatsapp,
        tipo_aparelho: deviceType,
        marca: brand,
        modelo: model,
        imei_serial: imei,
        relato_cliente: clientReport || null,
        servico_descricao: serviceDescription || null,
        peca_trocada: replacedPart || null,
        status: dbStatus, // Usar o valor mapeado
        valor_peca: partValue || 0,
        valor_taxa: taxValue || 0,
        valor_total: totalValue || 0,
        data_entrada: new Date(entryYear, entryMonth, entryDay)
      }
    );
    
    const ordemId = result.insertId;
    
    // Inserir itens do checklist
    if (checklistArray.length > 0) {
      await pool.query(
        `INSERT INTO checklist (ordem_id, item) VALUES ?`,
        [checklistArray.map(item => [ordemId, item])]
      );
    }
    
    // Processa upload de fotos se existirem
     if (req.files && req.files.length > 0) {
            const fotoValues = req.files.map(file => [ordemId, file.filename]);
            await pool.query(
                `INSERT INTO fotos (ordem_id, caminho) VALUES ?`,
                [fotoValues]
            );
        }
    
    res.status(201).json({ id: ordemId });
  } catch (err) {
    console.error('Erro ao criar ordem:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rota para listar todas as ordens
app.get('/api/ordens', async (req, res) => {
  try {
    const [ordens] = await pool.query(`
      SELECT os.*, 
        (SELECT GROUP_CONCAT(item) FROM checklist WHERE ordem_id = os.id) AS checklist,
        (SELECT GROUP_CONCAT(caminho) FROM fotos WHERE ordem_id = os.id) AS fotos
      FROM ordens_servico os
      ORDER BY os.data_criacao DESC
    `);
    
    // Processar checklist, fotos e converter valores numéricos
    const ordensFormatadas = ordens.map(ordem => ({
      ...ordem,
      checklist: ordem.checklist ? ordem.checklist.split(',') : [],
      fotos: ordem.fotos ? ordem.fotos.split(',') : [],
      valor_peca: parseFloat(ordem.valor_peca) || 0,
      valor_taxa: parseFloat(ordem.valor_taxa) || 0,
      valor_total: parseFloat(ordem.valor_total) || 0,
    }));
    
    res.json(ordensFormatadas);
  } catch (err) {
    console.error('Erro ao buscar ordens:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rota para buscar uma ordem específica
app.get('/api/ordens/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [ordem] = await pool.query('SELECT * FROM ordens_servico WHERE id = ?', [id]);
    if (!ordem.length) {
      return res.status(404).json({ error: 'Ordem não encontrada' });
    }
    
    const [checklist] = await pool.query('SELECT item FROM checklist WHERE ordem_id = ?', [id]);
    const [fotos] = await pool.query('SELECT caminho FROM fotos WHERE ordem_id = ?', [id]);
    
    res.json({
      ...ordem[0],
      checklist: checklist.map(item => item.item),
      fotos: fotos.map(foto => foto.caminho)
    });
  } catch (err) {
    console.error('Erro ao buscar ordem:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rota para deletar uma ordem
app.delete('/api/ordens/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Primeiro buscar os caminhos das fotos
    const [fotos] = await pool.query('SELECT caminho FROM fotos WHERE ordem_id = ?', [id]);
    
    // Deletar os arquivos físicos
    fotos.forEach(foto => {
      const filename = foto.caminho.replace('/api/images/', '');
      const filePath = path.join(__dirname, 'uploads', filename);
      
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
    
    // Depois deletar do banco de dados (o CASCADE vai deletar as fotos e checklist)
    await pool.query('DELETE FROM ordens_servico WHERE id = ?', [id]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao deletar ordem:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/ordens/:id', upload.array('fotos', 10), async (req, res) => {
  try {
    const { id } = req.params;
    
    const {
      clientName, whatsapp, deviceType, brand, model, imei,
      clientReport, serviceDescription, replacedPart, status,
      partValue, taxValue, totalValue, entryDay, entryMonth, entryYear,
      checklist, existingPhotos
    } = req.body;
    
    const checklistArray = typeof checklist === 'string' ? 
      JSON.parse(checklist) : (checklist || []);

    // Mapeamento de status
    const statusMap = {
        'pendente': 'pendente',
        'andamento': 'andamento',
        'concluido': 'concluido',
        'cancelado': 'cancelado'
    };
    const dbStatus = statusMap[status] || 'pendente';

    // Atualize a ordem principal
    await pool.query('UPDATE ordens_servico SET ? WHERE id = ?', [{
      nome_cliente: clientName,
      whatsapp: whatsapp,
      tipo_aparelho: deviceType,
      marca: brand,
      modelo: model,
      imei_serial: imei,
      relato_cliente: clientReport || null,
      servico_descricao: serviceDescription || null,
      peca_trocada: replacedPart || null,
      status: dbStatus,
      valor_peca: partValue || 0,
      valor_taxa: taxValue || 0,
      valor_total: totalValue || 0,
      data_entrada: new Date(entryYear, entryMonth, entryDay)
    }, id]);
    
    // Atualize o checklist (primeiro delete os existentes)
    await pool.query('DELETE FROM checklist WHERE ordem_id = ?', [id]);
    if (checklistArray.length > 0) {
      await pool.query(
        'INSERT INTO checklist (ordem_id, item) VALUES ?',
        [checklistArray.map(item => [id, item])]
      );
    }
    
    // Processar fotos existentes e novas
    const existingPhotosArray = existingPhotos ? 
      (typeof existingPhotos === 'string' ? JSON.parse(existingPhotos) : existingPhotos) : [];
    
    // Deletar fotos que foram removidas no frontend
    await deletePhotosFromOrder(id, existingPhotosArray);
    
    // Adicionar novas fotos se existirem
    if (req.files && req.files.length > 0) {
      const fotoValues = req.files.map(file => [id, file.filename]);
      await pool.query(
        'INSERT INTO fotos (ordem_id, caminho) VALUES ?',
        [fotoValues]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao atualizar ordem:', err);
    res.status(500).json({ error: err.message });
  }
});

async function deletePhotosFromOrder(orderId, photosToKeep = []) {
    // Buscar todas as fotos da ordem
    const [fotos] = await pool.query('SELECT caminho FROM fotos WHERE ordem_id = ?', [orderId]);
    
    // Deletar fotos que não estão na lista de fotos para manter
    for (const foto of fotos) {
        if (!photosToKeep.includes(foto.caminho)) {
            const filename = foto.caminho.replace('/api/images/', '');
            const filePath = path.join(__dirname, 'uploads', filename);
            
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            
            await pool.query('DELETE FROM fotos WHERE caminho = ? AND ordem_id = ?', [foto.caminho, orderId]);
        }
    }
}

//Status do backend na url
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Status da API</title></head>
      <body style="text-align: center; font-family: sans-serif; margin-top: 50px;">
        <h1>Backend tá funcionando e tudo ok!👍</h1>
        <img src="https://i.pinimg.com/736x/02/ce/4f/02ce4f43271873b91c022fb76a91a66b.jpg" alt="OK" width="200"/>
        <p>Servidor tá ativo na porta ${port}</p>
      </body>
    </html>
  `);
});

// Iniciar o servidor
app.listen(port, async () => {
  await createTables(); // <===== Desligar com "//" ao criar as tabelas
  console.log(`Servidor rodando na porta ${port}`);
}); 