// ------------------------------------------------------------
// 🔑 आपका Master Bot Token – यहाँ अपना नया Token डालें
// ------------------------------------------------------------
const MASTER_BOT_TOKEN = '8625601415:AAGIOdTkHOznIz_VlnehzsgvZpxXJG37O0Y';  // <-- @BotFather से नया लें

// ------------------------------------------------------------
// बाकी कोड – पूरी तरह से सुरक्षित और सटीक
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
// 🛠️ Railway CLI (ENV token के साथ)
// ------------------------------------------------------------
const runRailwayCmd = (token, args, cwd) => {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, RAILWAY_TOKEN: token };
    const child = spawn('npx', ['railway', ...args], { cwd, shell: true, env });

    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || stdout || `Command failed with code ${code}`));
      }
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

    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}: ${res.statusText}` };
    }

    const data = await res.json();

    if (data.errors) {
      return { success: false, error: data.errors[0].message };
    }

    // ✅ अगर projects नहीं हैं, तो empty array return करो – error नहीं
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
// Session Management
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
// Main Menu
// ------------------------------------------------------------
const showMainMenu = async (ctx, session, projectsList = null) => {
  // अगर projectsList नहीं दी गई, तो API से fetch करो
  if (!projectsList && session.railwayToken) {
    const result = await verifyAndListProjects(session.railwayToken);
    if (result.success) {
      projectsList = result.projects;
    } else {
      // ❌ Token invalid या API error
      return ctx.reply(
        `⚠️ *Could not connect to Railway API*\n\n` +
        `Error: ${result.error}\n\n` +
        `Please check your token or use /reset and /deploy again.`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  // ✅ अब projectsList कभी undefined नहीं होगी – empty array होगी तो "No projects" दिखेगा
  const projectCount = projectsList?.length || 0;

  let msg = `✅ *Connected to Railway!*\n\n`;
  if (projectCount > 0) {
    msg += `📋 *Existing Projects (${projectCount}):*\n`;
    projectsList.forEach(p => msg += `▫️ \`${p.id}\` - ${p.name}\n`);
  } else {
    msg += `📋 No existing projects found. (You can deploy to a NEW project.)\n`;
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
// 🚀 Execute Deployment (बिना --detach)
// ------------------------------------------------------------
const executeDeployment = async (ctx, session) => {
  const userId = ctx.from.id;
  const tempDir = path.join(os.tmpdir(), `rd_${userId}_${Date.now()}`);
  ctx.reply('⏳ Deploying... (this takes ~1-2 min)');

  try {
    // 1. Temp folder बनाओ
    await fs.mkdir(tempDir, { recursive: true });
    for (const [name, content] of Object.entries(session.files)) {
      await fs.writeFile(path.join(tempDir, name), content);
    }

    const projectName = `tb_${userId}_${Date.now()}`;
    const projectId = session.deployTargetProject;

    // 2. Project init / link
    if (projectId) {
      ctx.reply(`🔗 Linking to existing project: ${projectId}`);
      await runRailwayCmd(session.railwayToken, ['link', projectId], tempDir);
    } else {
      ctx.reply(`🆕 Creating new project: ${projectName}`);
      await runRailwayCmd(session.railwayToken, ['init', '-n', projectName], tempDir);
    }

    // 3. Deploy
    ctx.reply('📦 Uploading and deploying...');
    await runRailwayCmd(session.railwayToken, ['up'], tempDir);

    // 4. Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });

    ctx.reply(
      `✅ *Deployment Successful!*\n\n` +
      `Your bot is now live on Railway.\n` +
      `🔗 Check your Railway Dashboard for the URL.\n` +
      `(You can test it yourself.)`,
      { parse_mode: 'Markdown' }
    );

    session.stage = 'idle';
    session.deployTargetProject = null;

  } catch (err) {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch (e) {}
    ctx.reply(
      `❌ *Deployment Failed!*\n\n` +
      `\`\`\`${err.message.slice(0, 500)}\`\`\``,
      { parse_mode: 'Markdown' }
    );
    session.stage = 'idle';
  }
};

// ------------------------------------------------------------
// 🤖 Bot Commands
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
  ctx.reply(
    `📊 *Status*\n` +
    `Stage: ${session.stage}\n` +
    `Token: ${session.railwayToken ? '✅' : '❌'}\n` +
    `Files: ${Object.keys(session.files).length}`,
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
  ctx.reply('✅ Cancelled.');
});

// ------------------------------------------------------------
// 🎯 Inline Button Actions
// ------------------------------------------------------------
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
  ctx.reply(`🗑️ Type exact filename to delete.\nExisting: ${files.join(', ')}`);
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
    ctx.reply(
      `❌ *Token Error*\n\n` +
      `Could not fetch projects: ${result.error}\n\n` +
      `Please check your token or use /reset and /deploy again.`,
      { parse_mode: 'Markdown' }
    );
    return ctx.answerCbQuery();
  }

  if (result.projects.length === 0) {
    ctx.reply(
      `📋 *No existing projects found*\n\n` +
      `You have no projects in this account.\n` +
      `Please use *"Deploy to NEW Project"* instead.`,
      { parse_mode: 'Markdown' }
    );
    return ctx.answerCbQuery();
  }

  // ✅ अगर projects हैं तो list दिखाओ
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

// ------------------------------------------------------------
// 📝 Text Handler (State Machine)
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
    session.stage = 'waiting_code';
    ctx.reply(`📄 Now send the *content* of \`${text}\``, { parse_mode: 'Markdown' });
  }

  // ---- STATE: waiting_code ----
  else if (session.stage === 'waiting_code') {
    const fname = session.pendingFilename;
    if (text.length > 4096) {
      return ctx.reply('⚠️ Code too long! Please split into smaller files.');
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

  // ---- IDLE ----
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
