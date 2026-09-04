// ------------------------------------------------------------
// 🔑 आपका Master Bot Token – यहाँ डालें
// ------------------------------------------------------------
const MASTER_BOT_TOKEN = '8464608757:AAGbBQl5BLNP0mGNB3CdGkTxpo2di5X5xl0';  // <-- @BotFather से लें

// ------------------------------------------------------------
// बाकी कोड – पूरी तरह से Text Accumulator + DONE System
// ------------------------------------------------------------
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

if (!MASTER_BOT_TOKEN || MASTER_BOT_TOKEN === 'YOUR_NEW_TOKEN_HERE') {
  console.error('❌ MASTER_BOT_TOKEN is not set!');
  process.exit(1);
}

const bot = new Telegraf(MASTER_BOT_TOKEN);
const sessions = new Map();

// ------------------------------------------------------------
// 🛠️ Railway CLI – सुरक्षित (shell: false, --detach के साथ)
// ------------------------------------------------------------
const runRailwayCmd = (token, args, cwd) => {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['railway', ...args], {
      cwd,
      env: { ...process.env, RAILWAY_TOKEN: token },
    });

    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || `Command failed with code ${code}`));
      resolve(stdout);
    });
    child.on('error', (err) => reject(err));
  });
};

// ------------------------------------------------------------
// 🌐 API से Projects List (बिना CLI के)
// ------------------------------------------------------------
const verifyAndListProjects = async (token) => {
  try {
    const res = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        query: `query { projects { edges { node { id name } } } }`
      })
    });

    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    if (data.errors) return { success: false, error: data.errors[0].message };

    const projects = data.data?.projects?.edges?.map(e => ({
      id: e.node.id,
      name: e.node.name
    })) || [];

    return { success: true, projects };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

// ------------------------------------------------------------
// 📦 Session Management
// ------------------------------------------------------------
const getSession = (userId) => {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      stage: 'idle',             // idle | waiting_token | waiting_filename | waiting_code | waiting_delete | waiting_project_selection | deploy_confirm
      railwayToken: null,
      files: {},                 // filename → content (पूरी file)
      pendingFilename: null,
      deployTargetProject: null,
      fileChunks: [],            // Code के टुकड़े यहाँ जमा होंगे
    });
  }
  return sessions.get(userId);
};

// ------------------------------------------------------------
// 🖥️ Main Menu
// ------------------------------------------------------------
const showMainMenu = async (ctx, session, projectsList = null) => {
  if (!projectsList && session.railwayToken) {
    const result = await verifyAndListProjects(session.railwayToken);
    if (result.success) {
      projectsList = result.projects;
    } else {
      return ctx.reply(`⚠️ API Error: ${result.error}`, { parse_mode: 'Markdown' });
    }
  }

  const projectCount = projectsList?.length || 0;
  let msg = `✅ *Connected to Railway!*\n\n`;
  if (projectCount > 0) {
    msg += `📋 *Existing Projects (${projectCount}):*\n`;
    projectsList.forEach(p => msg += `▫️ \`${p.id}\` - ${p.name}\n`);
  } else {
    msg += `📋 No existing projects found.\n`;
  }

  const fileKeys = Object.keys(session.files);
  msg += `\n📁 *Your Files:* ${fileKeys.length ? fileKeys.join(', ') : '(none)'}`;

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
// 🚀 Execute Deployment – No Timeout (--detach)
// ------------------------------------------------------------
const executeDeployment = async (ctx, session) => {
  const userId = ctx.from.id;
  const tempDir = path.join(os.tmpdir(), `rd_${userId}_${Date.now()}`);

  // तुरंत Reply – Bot को Timeout न होने दें
  ctx.reply('⏳ *Deployment started!*\nCheck Railway Dashboard for progress.', { parse_mode: 'Markdown' });

  try {
    // Temp folder + Files
    await fs.mkdir(tempDir, { recursive: true });
    for (const [name, content] of Object.entries(session.files)) {
      await fs.writeFile(path.join(tempDir, name), content);
    }

    const projectName = `tb_${userId}_${Date.now()}`;
    const projectId = session.deployTargetProject;

    if (projectId) {
      await runRailwayCmd(session.railwayToken, ['link', projectId], tempDir);
    } else {
      await runRailwayCmd(session.railwayToken, ['init', '-n', projectName], tempDir);
    }

    // 🔥 --detach – background में deploy होगा
    await runRailwayCmd(session.railwayToken, ['up', '--detach'], tempDir);

    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });

    // Success – अब User खुद Dashboard पर URL देखेगा
    ctx.reply('✅ *Deployment triggered successfully!*\nYour bot will be live shortly on Railway.', { parse_mode: 'Markdown' });

  } catch (err) {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch (e) {}
    ctx.reply(`❌ *Deployment Failed!*\n\`\`\`${err.message.slice(0, 400)}\`\`\``, { parse_mode: 'Markdown' });
  }

  session.stage = 'idle';
  session.deployTargetProject = null;
};

// ------------------------------------------------------------
// 🤖 COMMANDS
// ------------------------------------------------------------
bot.start((ctx) => {
  const session = getSession(ctx.from.id);
  session.stage = 'idle';
  ctx.reply(
    `🤖 *Railway Master Bot*\n\n` +
    `Commands:\n` +
    `/deploy - Start deployment session\n` +
    `/status - Check session status\n` +
    `/reset - Clear all session data\n\n` +
    `📌 *How to add large code:*\n` +
    `1. Click "Add File" → Enter filename\n` +
    `2. Paste code in parts (each part any size)\n` +
    `3. When finished, type \`DONE\` (in caps) to save the file.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('reset', (ctx) => {
  sessions.delete(ctx.from.id);
  ctx.reply('✅ Session reset. Use /deploy to start fresh.');
});

bot.command('status', (ctx) => {
  const session = getSession(ctx.from.id);
  const fileCount = Object.keys(session.files).length;
  ctx.reply(
    `📊 *Status*\n` +
    `Stage: ${session.stage}\n` +
    `Token: ${session.railwayToken ? '✅' : '❌'}\n` +
    `Files: ${fileCount}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('deploy', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.railwayToken) {
    session.stage = 'waiting_token';
    return ctx.reply('🔑 Send your *Railway Account Token* (No Workspace).', { parse_mode: 'Markdown' });
  }
  await showMainMenu(ctx, session);
});

bot.command('cancel', (ctx) => {
  const session = getSession(ctx.from.id);
  session.stage = 'idle';
  session.fileChunks = [];
  session.pendingFilename = null;
  ctx.reply('✅ Cancelled.');
});

// ------------------------------------------------------------
// 🎯 INLINE BUTTONS
// ------------------------------------------------------------
bot.action('add_file', (ctx) => {
  const session = getSession(ctx.from.id);
  session.stage = 'waiting_filename';
  session.fileChunks = []; // पुराने chunks खाली करें
  ctx.reply(
    `✏️ Enter the *filename* (e.g., \`index.js\`, \`main.py\`).\n\n` +
    `After this, paste your code in parts.\n` +
    `When finished, type \`DONE\` (in capital letters).`,
    { parse_mode: 'Markdown' }
  );
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
  ctx.reply(`🗑️ Type the exact filename to delete.\nExisting: ${files.join(', ')}`);
  ctx.answerCbQuery();
});

bot.action('list_files', (ctx) => {
  const session = getSession(ctx.from.id);
  const files = Object.keys(session.files);
  ctx.reply(files.length ? `📂 ${files.join(', ')}` : '📂 No files.');
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
  if (!result.success) {
    ctx.reply(`❌ Token Error: ${result.error}`);
    return ctx.answerCbQuery();
  }

  if (result.projects.length === 0) {
    ctx.reply(
      `📋 No existing projects found.\nPlease use *"Deploy to NEW Project"*.`,
      { parse_mode: 'Markdown' }
    );
    return ctx.answerCbQuery();
  }

  let msg = '📋 *Select a Project ID:*\n\n';
  result.projects.forEach(p => msg += `▫️ \`${p.id}\` - ${p.name}\n`);
  msg += '\n✏️ Type the Project ID.';
  session.stage = 'waiting_project_selection';
  ctx.reply(msg, { parse_mode: 'Markdown' });
  ctx.answerCbQuery();
});

bot.action('reset_session', (ctx) => {
  sessions.delete(ctx.from.id);
  ctx.reply('✅ Session reset. Use /deploy to start fresh.');
  ctx.answerCbQuery();
});

// ------------------------------------------------------------
// 📝 TEXT HANDLER – केवल Accumulator + DONE System
// ------------------------------------------------------------
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  // ---- STATE: waiting_token ----
  if (session.stage === 'waiting_token') {
    session.railwayToken = text;
    session.stage = 'verifying';
    ctx.reply('⏳ Verifying token...');
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
    session.fileChunks = []; // नए file के लिए chunks empty
    session.stage = 'waiting_code';
    ctx.reply(
      `📄 Now send the *content* of \`${text}\`.\n\n` +
      `Paste the code in parts (any size).\n` +
      `When you have pasted all parts, type \`DONE\` (in capital letters) to finish.`,
      { parse_mode: 'Markdown' }
    );
  }

  // ---- STATE: waiting_code (Core Accumulator) ----
  else if (session.stage === 'waiting_code') {
    // अगर user ने DONE लिखा है → file complete करें
    if (text.toUpperCase() === 'DONE') {
      const fullContent = session.fileChunks.join('');
      const fname = session.pendingFilename;

      if (fullContent.length === 0) {
        return ctx.reply('❌ No content received! Please paste code first.');
      }

      // File को save करें
      session.files[fname] = fullContent;
      session.pendingFilename = null;
      session.fileChunks = [];
      session.stage = 'idle';

      ctx.reply(
        `✅ File \`${fname}\` saved successfully! (${fullContent.length} characters)`,
        { parse_mode: 'Markdown' }
      );
      await showMainMenu(ctx, session);
      return;
    }

    // वरना, इस part को जमा करें
    session.fileChunks.push(text);
    const totalSoFar = session.fileChunks.reduce((acc, chunk) => acc + chunk.length, 0);

    // User को फीडबैक दें
    await ctx.reply(
      `📥 Received part (${text.length} chars). Total so far: ${totalSoFar} chars.\n` +
      `Send more code, or type \`DONE\` when finished.`,
      { parse_mode: 'Markdown' }
    );
  }

  // ---- STATE: waiting_delete ----
  else if (session.stage === 'waiting_delete') {
    if (session.files[text]) {
      delete session.files[text];
      ctx.reply(`✅ Deleted \`${text}\``, { parse_mode: 'Markdown' });
    } else {
      ctx.reply(`❌ File \`${text}\` not found.`);
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
      `Target: \`${text}\`\n` +
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

  // ---- IDLE (कुछ नहीं) ----
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
