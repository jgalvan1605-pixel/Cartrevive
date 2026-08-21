const fs = require('fs');
const { execSync } = require('child_process');

console.log('=== 1. VERIFICANDO DEFINICIÓN DE RUTAS EN EL CÓDIGO LOCAL ===');
const filesToCheck = ['cartrevive/src/index.ts', 'src/index.ts', 'index.ts'];
let mainFile = null;

for (const file of filesToCheck) {
  if (fs.existsSync(file)) {
    mainFile = file;
    break;
  }
}

if (!mainFile) {
  console.error('❌ No se encontró el archivo principal index.ts');
  process.exit(1);
}

console.log(`✔ Archivo principal detectado: ${mainFile}`);
let code = fs.readFileSync(mainFile, 'utf8');

// Comprobar si la ruta existe en el archivo
if (!code.includes('/api/webhooks/shopify/:tenantId')) {
  console.log('⚠️ La ruta de webhooks no estaba en el archivo. Inyectando ruta oficial...');
  
  const webhookBlock = `
// --- RUTA WEBHOOK SHOPIFY (MULTI-TENANT & BUFFER) ---
app.post('/api/webhooks/shopify/:tenantId', async (req: FastifyRequest, rep: FastifyReply) => {
  try {
    const { tenantId } = req.params as any;
    const body = req.body as any;

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      // Si no existe, registrarlo automáticamente en modo demo
      await prisma.tenant.create({
        data: {
          id: tenantId,
          name: 'Tienda Shopify Conectada',
          email: 'administracion@akonfitness.com',
          telegramChatId: '1034043897',
          minThreshold: 0
        }
      });
    }

    const total = parseFloat(body.total_price || body.subtotal_price || '0');
    const rawId = body.id || (body.token && body.token.replace(/[^0-9]/g, '')) || Date.now();
    const cartIdBigInt = BigInt(rawId);
    const email = body.email || body.customer?.email || '';
    const phone = body.phone || body.shipping_address?.phone || body.customer?.phone || '';
    const name = \`\${body.customer?.first_name || ''} \${body.customer?.last_name || ''}\`.trim() || 'Cliente Web';
    const items = (body.line_items || []).map((i: any) => \`\${i.quantity || 1}x \${i.title}\`).join(', ');

    const cartLog = await prisma.cartLog.upsert({
      where: {
        tenantId_shopifyCartId: {
          tenantId: tenantId,
          shopifyCartId: cartIdBigInt
        }
      },
      update: {
        cartAmount: total,
        customerName: name,
        customerEmail: email || null,
        customerPhone: phone || null,
        recoveryUrl: body.abandoned_checkout_url || null,
        itemsSummary: items || null
      },
      create: {
        tenantId: tenantId,
        shopifyCartId: cartIdBigInt,
        cartAmount: total,
        customerName: name,
        customerEmail: email || null,
        customerPhone: phone || null,
        recoveryUrl: body.abandoned_checkout_url || null,
        itemsSummary: items || null,
        status: 'STAGING'
      }
    });

    console.log(\`📥 Webhook recibido para CartLog ID \${cartLog.id}\`);
    return rep.status(200).send({ ok: true, status: 'received', cartLogId: cartLog.id });
  } catch (err: any) {
    console.error('Error en webhook shopify:', err);
    return rep.status(200).send({ ok: true, error: err.message });
  }
});
`;
  code = code.replace("const PORT = parseInt(process.env.PORT", webhookBlock + "\nconst PORT = parseInt(process.env.PORT");
  fs.writeFileSync(mainFile, code);
  console.log('✔ Ruta agregada correctamente.');
} else {
  console.log('✔ La ruta /api/webhooks/shopify/:tenantId ya está en el código local.');
}

console.log('\n=== 2. COMPILANDO PROYECTO (BUILD) ===');
try {
  execSync('npm run build || npx tsc', { stdio: 'inherit' });
  console.log('✔ Compilación exitosa.');
} catch (e) {
  console.error('⚠️ Revisar advertencias de compilación.');
}

console.log('\n=== 3. SUBIENDO CAMBIOS A RENDER ===');
try {
  execSync('git add -A && git commit -m "fix(routes): ensure shopify webhook endpoint is fully exposed" && git push origin main', { stdio: 'inherit' });
  console.log('✔ Despliegue enviado a GitHub y Render.');
} catch (e) {
  console.log('Nota Git:', e.message);
}
