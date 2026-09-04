// ------------------------------------------------------------
// 🔑 आपका Master Bot Token – यहाँ डालें (सबसे ऊपर)
// ------------------------------------------------------------
const MASTER_BOT_TOKEN = '8625601415:AAGIOdTkHOznIz_VlnehzsgvZpxXJG37O0Y';   // <-- अपना असली Token डालें

// ------------------------------------------------------------
// बाकी कोड – कृपया न बदलें
// ------------------------------------------------------------
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ------ सुरक्षा जांच – अगर Token नहीं डाला तो बॉट न चले ------
if (!MASTER_BOT_TOKEN || MASTER_BOT_TOKEN === 'YOUR_BOT_FATHER_TOKEN_HERE') {
  console.error('❌ MASTER_BOT_TOKEN is not set! Please edit index.js and put your token.');
  process.exit(1);
}

const bot = new Telegraf(MASTER_BOT_TOKEN);
const sessions = new Map();  // Telegram UserID → session data

// ------------------------------------------------------------
// 🛠️ Railway CLI को ENV variable के साथ चलाएँ
// ------------------------------------------------------------
const runRailwayCmd = (token, args, cwd) => {
  return new Promise((resolve, reject) => {
    const cmd = 'npx';
    const cmdArgs = ['railway', ...args];
    const env = { ...process.env, RAILWAY_TOKEN: token };

    console.log(`[CMD] npx railway ${args.join(' ')}`);

    const child = spawn(cmd, cmdArgs, { cwd, shell: true, env });

    let stdout = '', stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      // अगर कोड 0 है तो success, वरना error
      if (code !== 0) {
        // stderr में npm warnings भी आ सकती हैं, लेकिन असली error वही है
        return reject(new Error(stderr || stdout || `Command failed with code ${code}`));
      }
      resolve(stdout);
    });

    child.on('error', (err) => reject(err));
  });
};

// ------------------------------------------------------------
// 🌐 नया: GraphQL API से Projects की List लें (CLI नहीं)
// ------------------------------------------------------------
const verifyAndListProjects = async (token) => {
  try {
    const response = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        query: `query { projects { edges { node { id name } } } }`
      })
    });

    const data = await response.json();

    if (data.errors) {
      return { success: false, error: data.errors[0].message };
    }

    const projects = data.data.projects.edges.map(edge => ({
      id: edge.node.id,
      name: edge.node.name
    }));

    return { success: true, projects };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// ------------------------------------------------------------
// 📦 Session Management
// ------------------------------------------------------------
const getSession = (userId) => {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      stage: 'idle',
      railwayToken: null,
      files: {},
      pendingFilename: null,
      deployTargetProject: null,
    });
  }
  return sessions.get(userId);
};

// ------------------------------------------------------------
// 🖥️ Main Menu (Inline Keyboard)
// ------------------------------------------------------------
const showMainMenu = async (ctx, session, projectsList = null) => {
  if (!projectsList && session.railwayToken) {
    const result = await verifyAndListProjects(session.railwayToken);
    if (result.success) {
      projectsList = result.projects;
    } else {
      return ctx.reply(`⚠️ Could not fetch projects: ${result.error}\nToken might be expired. Use /reset and /deploy again.`);
    }
  }

  let msg = `✅ *Connected to Railway!*\n\n`;
  if (projectsList && projectsList.length > 0) {
    msg += `📋 *Existing Projects (${projectsList.length}):*\n`;
    projectsList.forEach(p => msg += `▫️ \`${p.id}\` - ${p.name}\n`);
  } else {
    msg += `📋 No existing projects found.\n`;
  }

  msg += `\n📁 *Your Current Session Files:*\n`;
  const fileKeys = Object.keys(session.files);
  if (fileKeys.length === 0) msg += `(No files added yet)\n`;
  else fileKeys.forEach(f => msg += `▫️ ${f}\n`);

  const buttons = [
    [Markup.button.callback('📁 Add File', 'add_file')],
    [Markup.button.callback('🗑️ Delete File', 'delete_file')],
    [Markup.button.callback('📂 List Files', 'list_files')],
    [Markup.button.callback('🚀 Deploy to NEW Project', 'deploy_new')],
    [Markup.button.callback('⬆️ Deploy to EXISTING Project', 'deploy_existing')],
    [Markup.button.callback('❌ Reset Session', 'reset_session')],
  ];

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
};

// ------------------------------------------------------------
// 🚀 Execute Deployment
// ------------------------------------------------------------
const executeDeployment = async (ctx, session) => {
  const userId = ctx.from.id;
  const tempDir = path.join(os.tmpdir(), `rd_${userId}_${Date.now()}`);
  ctx.reply('⏳ Deploying... Please wait (this takes 1-2 minutes).');

  try {
    await fs.mkdir(tempDir, { recursive: true });
    for (const [fname, content] of Object.entries(session.files)) {
      await fs.writeFile(path.join(tempDir, fname), content, 'utf-8');
    }

    const projectName = `tb_${userId}_${Date.now()}`;
    let projectId = session.deployTargetProject;

    if (projectId) {
      await runRailwayCmd(session.railwayToken, ['link', projectId], tempDir);
    } else {
      await runRailwayCmd(session.railwayToken, ['init', '-n', projectName], tempDir);
    }

    await runRailwayCmd(session.railwayToken, ['up', '--detach'], tempDir);

    await fs.rm(tempDir, { recursive: true, force: true });

    ctx.reply(
      `✅ *Deployment Successful!*\n\n` +
      `Your bot is live on Railway.\n` +
      `Check your Railway Dashboard for the URL.\n` +
      `(You can test it yourself.)`,
      { parse_mode: 'Markdown' }
    );

    session.stage = 'idle';
    session.deployTargetProject = null;

  } catch (err) {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch (e) {}
    ctx.reply(`❌ Deployment failed:\n\`${err.message.slice(0, 400)}\``, { parse_mode: 'Markdown' });
    session.stage = 'idle';
  }
};

// ------------------------------------------------------------
// 🤖 BOT COMMANDS & HANDLERS
// ------------------------------------------------------------

bot.start((ctx) => {
  const session = getSession(ctx.from.id);
  session.stage = 'idle';
  ctx.reply('🤖 *Railway Master Bot*\n\nCommands: /deploy , /status , /reset', { parse_mode: 'Markdown' });
});

bot.command('reset', (ctx) => {
  sessions.delete(ctx.from.id);
  ctx.reply('✅ Session reset. Use /deploy to start fresh.');
});

bot.command('status', (ctx) => {
  const session = getSession(ctx.from.id);
  const fileCount = Object.keys(session.files).length;
  ctx.reply(
    `📊 *Status*\nStage: ${session.stage}\nToken: ${session.railwayToken ? '✅' : '❌'}\nFiles: ${fileCount}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('deploy', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.railwayToken) {
    session.stage = 'waiting_token';
    return ctx.reply('🔑 Please send your *Railway Account Token* (No Workspace).', { parse_mode: 'Markdown' });
  }
  await showMainMenu(ctx, session);
});

bot.command('cancel', (ctx) => {
  const session = getSession(ctx.from.id);
  session.stage = 'idle';
  ctx.reply('✅ Cancelled.');
});

// ------------------- Inline Button Actions -------------------
bot.action('add_file', (ctx) => {
  const session = getSession(ctx.from.id);
  session.stage = 'waiting_filename';
  ctx.reply('✏️ Enter the *filename* (e.g., `index.js`, `main.py`):', { parse_mode: 'Markdown' });
  ctx.answerCbQuery();
});

bot.action('delete_file', (ctx) => {
  const session = getSession(ctx.from.id);
  const files = Object.keys(session.files);
  if (files.length === 0) {
    ctx.reply('❌ No files to delete.');
    return ctx.answerCbQuery();
  }
  session.stage = 'waiting_delete';
  ctx.reply(`🗑️ Type the exact filename to delete.\nExisting: ${files.join(', ')}`, { parse_mode: 'Markdown' });
  ctx.answerCbQuery();
});

bot.action('list_files', (ctx) => {
  const session = getSession(ctx.from.id);
  const files = Object.keys(session.files);
  if (files.length === 0) {
    ctx.reply('📂 No files in session.');
  } else {
    ctx.reply(`📂 *Your Files:*\n${files.map(f => `▫️ ${f}`).join('\n')}`, { parse_mode: 'Markdown' });
  }
  ctx.answerCbQuery();
});

bot.action('deploy_new', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (Object.keys(session.files).length === 0) {
    ctx.reply('❌ No files to deploy. Add files first!');
    return ctx.answerCbQuery();
  }
  session.deployTargetProject = null;
  session.stage = 'deploy_confirm';
  ctx.reply(
    `⚠️ *Deploy to NEW Project*\n\n` +
    `This will create a new project and deploy your files.\n` +
    `Files: ${Object.keys(session.files).join(', ')}\n\n` +
    `Type *CONFIRM* to proceed, or /cancel to abort.`,
    { parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

bot.action('deploy_existing', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (Object.keys(session.files).length === 0) {
    ctx.reply('❌ No files to deploy.');
    return ctx.answerCbQuery();
  }

  const result = await verifyAndListProjects(session.railwayToken);
  if (!result.success || result.projects.length === 0) {
    ctx.reply(`❌ No existing projects found or token invalid.\nError: ${result.error}`);
    return ctx.answerCbQuery();
  }

  let msg = '📋 *Select a Project ID to deploy to:*\n\n';
  result.projects.forEach(p => msg += `▫️ \`${p.id}\` - ${p.name}\n`);
  msg += '\n✏️ Type the *Project ID* you want to deploy to.';

  session.stage = 'waiting_project_selection';
  ctx.reply(msg, { parse_mode: 'Markdown' });
  ctx.answerCbQuery();
});

bot.action('reset_session', (ctx) => {
  sessions.delete(ctx.from.id);
  ctx.reply('✅ Session reset. Use /deploy to start fresh.');
  ctx.answerCbQuery();
});

// ------------------- Text message handler (State Machine) -------------------
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const text = ctx.message.text.trim();

  if (text.startsWith('/')) return;

  // ---- STATE: waiting_token ----
  if (session.stage === 'waiting_token') {
    session.railwayToken = text;
    session.stage = 'verifying';
    ctx.reply('⏳ Verifying token via API...');

    const result = await verifyAndListProjects(text);
    if (!result.success) {
      session.railwayToken = null;
      session.stage = 'waiting_token';
      return ctx.reply(`❌ Invalid token: ${result.error}`);
    }

    session.stage = 'idle';
    await showMainMenu(ctx, session, result.projects);
  }

  // ---- STATE: waiting_filename ----
  else if (session.stage === 'waiting_filename') {
    session.pendingFilename = text;
    session.stage = 'waiting_code';
    ctx.reply(`📄 Now send the *content* of \`${text}\` (plain text).`, { parse_mode: 'Markdown' });
  }

  // ---- STATE: waiting_code ----
  else if (session.stage === 'waiting_code') {
    const fname = session.pendingFilename;
    if (text.length > 4096) {
      return ctx.reply('⚠️ Code is too long! Please split into smaller files.');
    }
    session.files[fname] = text;
    session.pendingFilename = null;
    session.stage = 'idle';
    ctx.reply(`✅ File \`${fname}\` saved. (${text.length} chars)`);
    await showMainMenu(ctx, session);
  }

  // ---- STATE: waiting_delete ----
  else if (session.stage === 'waiting_delete') {
    if (session.files[text]) {
      delete session.files[text];
      ctx.reply(`✅ Deleted \`${text}\``, { parse_mode: 'Markdown' });
    } else {
      ctx.reply(`❌ File not found.`);
    }
    session.stage = 'idle';
    await showMainMenu(ctx, session);
  }

  // ---- STATE: waiting_project_selection ----
  else if (session.stage === 'waiting_project_selection') {
    session.deployTargetProject = text;
    session.stage = 'deploy_confirm';
    ctx.reply(
      `⚠️ *Confirm Deploy to EXISTING Project*\n\n` +
      `Target Project ID: \`${text}\`\n` +
      `Files: ${Object.keys(session.files).join(', ')}\n\n` +
      `Type *CONFIRM* to proceed, or /cancel to abort.`,
      { parse_mode: 'Markdown' }
    );
  }

  // ---- STATE: deploy_confirm ----
  else if (session.stage === 'deploy_confirm') {
    if (text.toUpperCase() === 'CONFIRM') {
      await executeDeployment(ctx, session);
    } else {
      ctx.reply('❌ Deployment cancelled.');
      session.stage = 'idle';
      await showMainMenu(ctx, session);
    }
  }

  else {
    ctx.reply('Please use the menu buttons or /deploy to start.');
  }
});

// ------------------------------------------------------------
// 🚀 START THE BOT
// ------------------------------------------------------------
bot.launch().then(() => {
  console.log(`🚀 Master Bot is running...`);
  console.log(`📡 Username: @${bot.botInfo.username}`);
}).catch(err => {
  console.error('❌ Launch error:', err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
