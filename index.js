// ------------------------------------------------------------
// 🔑 आपका Master Bot Token – यहाँ डालें
// ------------------------------------------------------------
const MASTER_BOT_TOKEN = '8625601415:AAGIOdTkHOznIz_VlnehzsgvZpxXJG37O0Y';  // <-- @BotFather से लें

// ------------------------------------------------------------
// बाकी कोड – FIXED: init + up for new project
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
// 🛠️ Railway CLI – @railway/cli, STDIN बंद, Timeout
// ------------------------------------------------------------
const runRailwayCmd = (token, args, cwd) => {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--yes', '@railway/cli', ...args], {
      cwd,
      env: { ...process.env, RAILWAY_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '', stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`⏱️ Command timed out after 120s: @railway/cli ${args.join(' ')}`));
    }, 120000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const fullOutput = (stdout + '\n' + stderr).trim();
        const errorMsg = fullOutput || `Command failed with code ${code}`;
        return reject(new Error(errorMsg));
      }
      resolve(stdout);
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
};

// ------------------------------------------------------------
// 🌐 API से Projects List
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
      stage: 'idle',
      railwayToken: null,
      files: {},
      pendingFilename: null,
      deployTargetProject: null,
      fileChunks: [],
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
    if (result.success) projectsList = result.projects;
    else return ctx.reply(`⚠️ API Error: ${result.error}`, { parse_mode: 'Markdown' });
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

  if (!session.files['package.json'] && Object.keys(session.files).length > 0) {
    msg += `\n\n⚠️ *Missing package.json!* Railway needs it to deploy Node.js apps.`;
  }

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
// 🚀 FIXED DEPLOYMENT – अब init और up अलग-अलग
// ------------------------------------------------------------
const executeDeployment = (ctx, session) => {
  const userId = ctx.from.id;
  const tempDir = path.join(os.tmpdir(), `rd_${userId}_${Date.now()}`);

  if (!session.files['package.json']) {
    return ctx.reply(
      '❌ *Missing `package.json`!*\n\n' +
      'Railway needs `package.json` to identify your project as a Node.js app.\n' +
      'Please add a file named **package.json** using the "Add File" button, then try again.',
      { parse_mode: 'Markdown' }
    );
  }

  ctx.reply('⏳ *Deployment started!* It will take 1-2 minutes. Check progress here (I will notify if it fails).', { parse_mode: 'Markdown' });

  (async () => {
    try {
      await fs.mkdir(tempDir, { recursive: true });
      for (const [name, content] of Object.entries(session.files)) {
        await fs.writeFile(path.join(tempDir, name), content);
      }

      const projectName = `tb_${userId}_${Date.now()}`;
      const projectId = session.deployTargetProject;

      if (projectId) {
        // Existing Project: सीधे up --project
        await runRailwayCmd(session.railwayToken, ['up', '--project', projectId], tempDir);
      } else {
        // 🔥 NEW Project: पहले init -n, फिर up
        await runRailwayCmd(session.railwayToken, ['init', '-n', projectName], tempDir);
        await runRailwayCmd(session.railwayToken, ['up'], tempDir);
      }

      await fs.rm(tempDir, { recursive: true, force: true });

      await ctx.reply('✅ *Deployment triggered successfully!* Your bot will be live shortly on Railway.', { parse_mode: 'Markdown' });

    } catch (err) {
      try { await fs.rm(tempDir, { recursive: true, force: true }); } catch (e) {}
      await ctx.reply(
        `❌ *Deployment Failed!*\n\nReason:\n\`\`\`${err.message.slice(0, 600)}\`\`\`\n\n(If you see "missing package.json", please add it.)`,
        { parse_mode: 'Markdown' }
      );
    }
  })();

  session.stage = 'idle';
  session.deployTargetProject = null;
};

// ------------------------------------------------------------
// 🤖 COMMANDS & BUTTONS (बाकी सब वही)
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
    `📊 *Status*\nStage: ${session.stage}\nToken: ${session.railwayToken ? '✅' : '❌'}\nFiles: ${fileCount}`,
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

// ------------------- INLINE BUTTONS -------------------
bot.action('add_file', (ctx) => {
  const session = getSession(ctx.from.id);
  session.stage = 'waiting_filename';
  session.fileChunks = [];
  ctx.reply(
    `✏️ Enter the *filename* (e.g., \`index.js\`, \`package.json\`).\n\nAfter this, paste your code in parts.\nWhen finished, type \`DONE\`.`,
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
    `⚠️ *Deploy to NEW Project*\n\nFiles: ${Object.keys(session.files).join(', ')}\n\nType *CONFIRM* to proceed.`,
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
    ctx.reply(`📋 No existing projects found.\nPlease use *"Deploy to NEW Project"*.`, { parse_mode: 'Markdown' });
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
  ctx.reply('✅ Session reset.');
  ctx.answerCbQuery();
});

// ------------------------------------------------------------
// 📝 TEXT HANDLER
// ------------------------------------------------------------
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

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
  else if (session.stage === 'waiting_filename') {
    session.pendingFilename = text;
    session.fileChunks = [];
    session.stage = 'waiting_code';
    ctx.reply(`📄 Now send content of \`${text}\`. Type \`DONE\` when finished.`, { parse_mode: 'Markdown' });
  }
  else if (session.stage === 'waiting_code') {
    if (text.toUpperCase() === 'DONE') {
      const fullContent = session.fileChunks.join('');
      const fname = session.pendingFilename;
      if (!fullContent) return ctx.reply('❌ No content!');
      session.files[fname] = fullContent;
      session.pendingFilename = null;
      session.fileChunks = [];
      session.stage = 'idle';
      ctx.reply(`✅ File \`${fname}\` saved! (${fullContent.length} chars)`, { parse_mode: 'Markdown' });
      await showMainMenu(ctx, session);
      return;
    }
    session.fileChunks.push(text);
    const total = session.fileChunks.reduce((a, c) => a + c.length, 0);
    ctx.reply(`📥 Part received (${text.length} chars). Total: ${total}. Send more or \`DONE\`.`);
  }
  else if (session.stage === 'waiting_delete') {
    if (session.files[text]) {
      delete session.files[text];
      ctx.reply(`✅ Deleted \`${text}\``, { parse_mode: 'Markdown' });
    } else ctx.reply(`❌ Not found.`);
    session.stage = 'idle';
    await showMainMenu(ctx, session);
  }
  else if (session.stage === 'waiting_project_selection') {
    session.deployTargetProject = text;
    session.stage = 'deploy_confirm';
    ctx.reply(`⚠️ Confirm deploy to \`${text}\`? Type CONFIRM.`, { parse_mode: 'Markdown' });
  }
  else if (session.stage === 'deploy_confirm') {
    if (text.toUpperCase() === 'CONFIRM') {
      executeDeployment(ctx, session);
    } else {
      ctx.reply('❌ Cancelled.');
      session.stage = 'idle';
      await showMainMenu(ctx, session);
    }
  }
  else {
    ctx.reply('Please use the menu buttons or /deploy.');
  }
});

// ------------------------------------------------------------
// 🚀 START
// ------------------------------------------------------------
bot.launch().then(() => {
  console.log(`🚀 Master Bot is running...`);
  console.log(`📡 @${bot.botInfo.username}`);
}).catch(err => console.error('Launch error:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
