// ------------------------------------------------------------
// 🔑 आपका Master Bot Token – यहाँ अपना असली Token डालें
// ------------------------------------------------------------
const MASTER_BOT_TOKEN = '8625601415:AAGIOdTkHOznIz_VlnehzsgvZpxXJG37O0Y';

// ------------------------------------------------------------
// Railway Master Bot — FINAL VERSION
// Folder-style navigation: Projects → Services → Files
// ------------------------------------------------------------
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

if (!MASTER_BOT_TOKEN || MASTER_BOT_TOKEN === 'YOUR_BOT_FATHER_TOKEN_HERE') {
  console.error('❌ MASTER_BOT_TOKEN is not set!');
  process.exit(1);
}

const bot = new Telegraf(MASTER_BOT_TOKEN);
const sessions = new Map();

const RAILWAY_GRAPHQL_URL = 'https://backboard.railway.com/graphql/v2';

// ------------------------------------------------------------
// 🛠️ Railway CLI – सिर्फ़ `up` के लिए, असली Project Token के साथ
// ------------------------------------------------------------
const runRailwayCmd = (projectToken, args, cwd) => {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--yes', '@railway/cli', ...args], {
      cwd,
      env: { ...process.env, RAILWAY_TOKEN: projectToken },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`⏱️ Command timed out after 120s: @railway/cli ${args.join(' ')}`));
    }, 120000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const fullOutput = (stdout + '\n' + stderr).trim();
        reject(new Error(fullOutput || `Command failed with code ${code}`));
        return;
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
// 🌐 GraphQL Helpers
// ------------------------------------------------------------
const graphqlRequest = async (accountToken, query, variables = {}) => {
  const res = await fetch(RAILWAY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accountToken}`
    },
    body: JSON.stringify({ query, variables })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data.data;
};

// सारी workspaces (personal + कोई team) निकालो
const getWorkspaces = async (accountToken) => {
  const data = await graphqlRequest(accountToken, `query { me { workspaces { id name } } }`);
  return data?.me?.workspaces || [];
};

// Personal/पहली workspace id (नया project बनाने के लिए डिफ़ॉल्ट)
const getWorkspaceId = async (accountToken) => {
  const workspaces = await getWorkspaces(accountToken);
  return workspaces.length ? workspaces[0].id : null;
};

// 🔑 फिक्स: टॉप-लेवल `query { projects {...} }` एक known Railway bug है —
// जब account में एक से ज़्यादा workspaces (personal + कोई team) हों तो यह
// randomly/incomplete list देता है। सही तरीका: हर workspace को अलग से query करो।
const verifyAndListProjects = async (accountToken) => {
  try {
    const workspaces = await getWorkspaces(accountToken);
    if (workspaces.length === 0) return { success: true, projects: [] };

    const allProjects = [];
    for (const ws of workspaces) {
      const data = await graphqlRequest(accountToken,
        `query workspace($id: String!) {
          workspace(workspaceId: $id) {
            projects { edges { node { id name } } }
          }
        }`,
        { id: ws.id }
      );
      const edges = data?.workspace?.projects?.edges || [];
      edges.forEach(e => allProjects.push({
        id: e.node.id,
        name: e.node.name,
        workspaceName: ws.name,
      }));
    }
    return { success: true, projects: allProjects };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

// नया project बनाओ — नाम पूरी तरह यूज़र का दिया हुआ, कहीं भी Telegram ID embed नहीं होती
const createProject = async (accountToken, name) => {
  const workspaceId = await getWorkspaceId(accountToken);
  if (!workspaceId) throw new Error('कोई workspace नहीं मिली। Railway dashboard पर account चेक करें।');
  const data = await graphqlRequest(accountToken,
    `mutation projectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { id } }`,
    { input: { name, workspaceId } }
  );
  return data.projectCreate.id;
};

const deleteProject = async (accountToken, projectId) => {
  const data = await graphqlRequest(accountToken,
    `mutation projectDelete($id: String!) { projectDelete(id: $id) }`,
    { id: projectId }
  );
  return data.projectDelete;
};

// Project की पूरी जानकारी — नाम, services, environments — एक ही कॉल में
const getProjectDetails = async (accountToken, projectId) => {
  const data = await graphqlRequest(accountToken,
    `query project($id: String!) {
      project(id: $id) {
        id
        name
        services { edges { node { id name } } }
        environments { edges { node { id name } } }
      }
    }`,
    { id: projectId }
  );
  const p = data?.project;
  if (!p) return null;
  const envs = p.environments?.edges?.map(e => e.node) || [];
  const prodEnv = envs.find(e => e.name?.toLowerCase() === 'production') || envs[0] || null;
  return {
    id: p.id,
    name: p.name,
    services: p.services?.edges?.map(e => e.node) || [],
    defaultEnvironmentId: prodEnv?.id || null,
  };
};

const createService = async (accountToken, projectId, name) => {
  const data = await graphqlRequest(accountToken,
    `mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
    { input: { projectId, name } }
  );
  return data.serviceCreate;
};

const deleteService = async (accountToken, serviceId) => {
  const data = await graphqlRequest(accountToken,
    `mutation serviceDelete($id: String!) { serviceDelete(id: $id) }`,
    { id: serviceId }
  );
  return data.serviceDelete;
};

// असली Project-scoped token बनाओ — यही `railway up` स्वीकार करता है
const createProjectToken = async (accountToken, projectId, environmentId, name) => {
  const data = await graphqlRequest(accountToken,
    `mutation projectTokenCreate($input: ProjectTokenCreateInput!) { projectTokenCreate(input: $input) }`,
    { input: { projectId, environmentId, name } }
  );
  return data.projectTokenCreate;
};

// ------------------------------------------------------------
// 📦 Session Management
// ------------------------------------------------------------
const getSession = (userId) => {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      stage: 'idle',
      railwayToken: null,        // Account Token
      currentProjectId: null,
      currentProjectName: null,
      currentServiceId: null,
      currentServiceName: null,
      serviceFiles: {},          // { [serviceId]: { filename: content } }
      pendingFilename: null,
      fileChunks: [],
    });
  }
  return sessions.get(userId);
};

const getCurrentFiles = (session) => {
  if (!session.currentServiceId) return {};
  if (!session.serviceFiles[session.currentServiceId]) session.serviceFiles[session.currentServiceId] = {};
  return session.serviceFiles[session.currentServiceId];
};

// ------------------------------------------------------------
// 🖥️ UI: Projects List (टॉप लेवल)
// ------------------------------------------------------------
const showProjectsMenu = async (ctx, session) => {
  const result = await verifyAndListProjects(session.railwayToken);
  if (!result.success) return ctx.reply(`⚠️ API Error: ${result.error}`, { parse_mode: 'Markdown' });

  session.currentProjectId = null;
  session.currentProjectName = null;
  session.currentServiceId = null;
  session.currentServiceName = null;

  const buttons = result.projects.map(p =>
    [Markup.button.callback(`📂 ${p.name}`, `proj:${p.id}`)]
  );
  buttons.push([Markup.button.callback('➕ New Project', 'newproj')]);
  buttons.push([Markup.button.callback('❌ Reset Session', 'reset_session')]);

  const msg = result.projects.length
    ? `📋 *Your Projects (${result.projects.length}):*\nकिसी project पर टैप करें उसे खोलने के लिए।`
    : `📋 कोई project नहीं मिला। नया बनाएँ:`;

  await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
};

// ------------------------------------------------------------
// 🖥️ UI: Services List (किसी एक Project के अंदर)
// ------------------------------------------------------------
const showServicesMenu = async (ctx, session) => {
  const details = await getProjectDetails(session.railwayToken, session.currentProjectId);
  if (!details) return ctx.reply('❌ Project नहीं मिला (शायद डिलीट हो चुका है)।');

  session.currentProjectName = details.name;
  session.currentServiceId = null;
  session.currentServiceName = null;

  const buttons = details.services.map(s => [Markup.button.callback(`⚙️ ${s.name}`, `svc:${s.id}`)]);
  buttons.push([Markup.button.callback('➕ New Service', 'newsvc')]);
  buttons.push([Markup.button.callback('🗑️ Delete This Project', 'delproj')]);
  buttons.push([Markup.button.callback('⬅️ Back to Projects', 'backprojects')]);

  const msg = details.services.length
    ? `📂 *${details.name}*\n⚙️ *Services (${details.services.length}):*`
    : `📂 *${details.name}*\nइस project में अभी कोई service नहीं है।`;

  await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
};

// ------------------------------------------------------------
// 🖥️ UI: एक Service के अंदर (Files + Deploy)
// ------------------------------------------------------------
const showServiceMenu = async (ctx, session) => {
  const files = getCurrentFiles(session);
  const fileKeys = Object.keys(files);

  let msg = `⚙️ *${session.currentServiceName}*\n📂 Project: ${session.currentProjectName}\n\n`;
  msg += `📁 *Files:* ${fileKeys.length ? fileKeys.join(', ') : '(none)'}`;
  if (!files['package.json'] && fileKeys.length > 0) {
    msg += `\n\n⚠️ *Missing package.json!* Railway को Node.js app पहचानने के लिए यह ज़रूरी है।`;
  }

  const buttons = [
    [Markup.button.callback('📁 Add File', 'addfile')],
    [Markup.button.callback('🗑️ Delete File', 'delfile')],
    [Markup.button.callback('📂 List Files', 'listfiles')],
    [Markup.button.callback('🚀 Deploy This Service', 'deploy_ask')],
    [Markup.button.callback('🗑️ Delete This Service', 'delsvc')],
    [Markup.button.callback('⬅️ Back to Services', 'backservices')],
  ];

  await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
};

// ------------------------------------------------------------
// 🚀 Deployment — किसी एक चुनी हुई Service में
// ------------------------------------------------------------
const executeServiceDeploy = (ctx, session) => {
  const userId = ctx.from.id;
  const tempDir = path.join(os.tmpdir(), `rd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const files = getCurrentFiles(session);

  if (!files['package.json']) {
    return ctx.reply(
      '❌ *Missing `package.json`!*\nपहले "Add File" से package.json जोड़ें, फिर दोबारा Deploy करें।',
      { parse_mode: 'Markdown' }
    );
  }

  const projectId = session.currentProjectId;
  const serviceId = session.currentServiceId;
  const serviceName = session.currentServiceName;

  ctx.reply('⏳ *Deployment started!* 1-2 मिनट लगेंगे।', { parse_mode: 'Markdown' });

  (async () => {
    try {
      await fs.mkdir(tempDir, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(path.join(tempDir, name), content);
      }

      const accountToken = session.railwayToken;
      const details = await getProjectDetails(accountToken, projectId);
      if (!details || !details.defaultEnvironmentId) {
        throw new Error('Environment नहीं मिला।');
      }

      const projectToken = await createProjectToken(
        accountToken, projectId, details.defaultEnvironmentId, `bot-deploy-${Date.now()}`
      );
      if (!projectToken) throw new Error('Project Token नहीं बन पाया।');

      // 🔑 --service से बताया जा रहा है कि किस service में deploy करना है
      await runRailwayCmd(projectToken, ['up', '--service', serviceId], tempDir);

      await fs.rm(tempDir, { recursive: true, force: true });
      await ctx.reply(`✅ *Deployment triggered!*\nService: \`${serviceName}\` जल्द ही live होगी।`, { parse_mode: 'Markdown' });
    } catch (err) {
      try { await fs.rm(tempDir, { recursive: true, force: true }); } catch (e) {}
      await ctx.reply(
        `❌ *Deployment Failed!*\n\`\`\`${err.message.slice(0, 600)}\`\`\``,
        { parse_mode: 'Markdown' }
      );
    }
  })();
};

// ------------------------------------------------------------
// 🤖 COMMANDS
// ------------------------------------------------------------
bot.start((ctx) => {
  const session = getSession(ctx.from.id);
  session.stage = 'idle';
  ctx.reply(
    `🤖 *Railway Master Bot*\n\n` +
    `/deploy - Projects खोलें / session शुरू करें\n` +
    `/status - Session status देखें\n` +
    `/reset - सब कुछ साफ़ करें\n\n` +
    `📌 फ्लो: Projects → Services → Files → Deploy\n\n` +
    `⚠️ *Files भेजते वक़्त ज़रूरी नियम:*\n` +
    `पूरा code अपने editor से एक ही बार में copy करें और एक ही बार में paste करके भेजें — चाहे कितना भी बड़ा हो। Telegram उसे खुद कई messages में बाँट देगा, बॉट उन्हें सही तरीके से वापस जोड़ लेगा।\n` +
    `❌ कोड को खुद मैन्युअली टुकड़ों में बाँटकर अलग-अलग बार paste ना करें — इससे lines टूट सकती हैं।`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('reset', (ctx) => {
  sessions.delete(ctx.from.id);
  ctx.reply('✅ Session reset. /deploy से दोबारा शुरू करें।');
});

bot.command('status', (ctx) => {
  const session = getSession(ctx.from.id);
  ctx.reply(
    `📊 *Status*\nStage: ${session.stage}\nToken: ${session.railwayToken ? '✅' : '❌'}\n` +
    `Project: ${session.currentProjectName || '(none)'}\nService: ${session.currentServiceName || '(none)'}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('deploy', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.railwayToken) {
    session.stage = 'waiting_token';
    return ctx.reply(
      '🔑 Send your *Railway Account Token* (Account → Tokens → "No Workspace" selected).',
      { parse_mode: 'Markdown' }
    );
  }
  session.stage = 'idle';
  await showProjectsMenu(ctx, session);
});

bot.command('cancel', (ctx) => {
  const session = getSession(ctx.from.id);
  session.stage = 'idle';
  session.fileChunks = [];
  session.pendingFilename = null;
  ctx.reply('✅ Cancelled.');
});

// ------------------- INLINE BUTTONS -------------------

bot.action(/^proj:(.+)$/, async (ctx) => {
  const session = getSession(ctx.from.id);
  session.currentProjectId = ctx.match[1];
  await showServicesMenu(ctx, session);
  ctx.answerCbQuery();
});

bot.action('newproj', (ctx) => {
  const session = getSession(ctx.from.id);
  session.stage = 'waiting_new_project_name';
  ctx.reply('✏️ नए Project का नाम टाइप करें:');
  ctx.answerCbQuery();
});

bot.action('backprojects', async (ctx) => {
  const session = getSession(ctx.from.id);
  await showProjectsMenu(ctx, session);
  ctx.answerCbQuery();
});

bot.action('delproj', (ctx) => {
  const session = getSession(ctx.from.id);
  session.stage = 'waiting_delete_project_confirm';
  ctx.reply(
    `⚠️ *पक्का Project डिलीट करना है?*\nइसके अंदर की सारी services भी डिलीट हो जाएँगी — यह वापस नहीं होगा।\n\n` +
    `Confirm करने के लिए project का यह नाम टाइप करें:\n\`${session.currentProjectName}\``,
    { parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

bot.action(/^svc:(.+)$/, async (ctx) => {
  const session = getSession(ctx.from.id);
  const serviceId = ctx.match[1];
  const details = await getProjectDetails(session.railwayToken, session.currentProjectId);
  const svc = details?.services?.find(s => s.id === serviceId);
  if (!svc) {
    ctx.reply('❌ Service नहीं मिली।');
    return ctx.answerCbQuery();
  }
  session.currentServiceId = svc.id;
  session.currentServiceName = svc.name;
  await showServiceMenu(ctx, session);
  ctx.answerCbQuery();
});

bot.action('newsvc', (ctx) => {
  const session = getSession(ctx.from.id);
  session.stage = 'waiting_new_service_name';
  ctx.reply('✏️ नई Service का नाम टाइप करें:');
  ctx.answerCbQuery();
});

bot.action('backservices', async (ctx) => {
  const session = getSession(ctx.from.id);
  await showServicesMenu(ctx, session);
  ctx.answerCbQuery();
});

bot.action('delsvc', (ctx) => {
  const session = getSession(ctx.from.id);
  session.stage = 'waiting_delete_service_confirm';
  ctx.reply(
    `⚠️ *पक्का Service डिलीट करना है?*\nयह वापस नहीं होगा।\n\n` +
    `Confirm करने के लिए service का यह नाम टाइप करें:\n\`${session.currentServiceName}\``,
    { parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

bot.action('addfile', (ctx) => {
  const session = getSession(ctx.from.id);
  session.stage = 'waiting_filename';
  session.fileChunks = [];
  ctx.reply(
    `✏️ Enter the *filename* (e.g., \`index.js\`, \`package.json\`).\n\nफिर code parts में पेस्ट करें, आख़िर में \`DONE\` टाइप करें।`,
    { parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

bot.action('delfile', (ctx) => {
  const session = getSession(ctx.from.id);
  const files = getCurrentFiles(session);
  const keys = Object.keys(files);
  if (keys.length === 0) {
    ctx.reply('❌ कोई file नहीं।');
    return ctx.answerCbQuery();
  }
  session.stage = 'waiting_delete_filename';
  ctx.reply(`🗑️ Delete करने के लिए exact filename टाइप करें।\nMौजूद: ${keys.join(', ')}`);
  ctx.answerCbQuery();
});

bot.action('listfiles', (ctx) => {
  const session = getSession(ctx.from.id);
  const files = getCurrentFiles(session);
  const keys = Object.keys(files);
  ctx.reply(keys.length ? `📂 ${keys.join(', ')}` : '📂 No files.');
  ctx.answerCbQuery();
});

bot.action('deploy_ask', (ctx) => {
  const session = getSession(ctx.from.id);
  ctx.reply(
    `🚀 *${session.currentServiceName}* में deploy करें?`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, Deploy', 'deploy_yes'), Markup.button.callback('❌ Cancel', 'deploy_no')]
    ])}
  );
  ctx.answerCbQuery();
});

bot.action('deploy_yes', (ctx) => {
  const session = getSession(ctx.from.id);
  executeServiceDeploy(ctx, session);
  ctx.answerCbQuery();
});

bot.action('deploy_no', (ctx) => {
  ctx.reply('❌ Cancelled.');
  ctx.answerCbQuery();
});

bot.action('reset_session', (ctx) => {
  sessions.delete(ctx.from.id);
  ctx.reply('✅ Session reset.');
  ctx.answerCbQuery();
});

// ------------------------------------------------------------
// 📝 TEXT HANDLER (State Machine)
// ------------------------------------------------------------
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const rawText = ctx.message.text;
  const text = rawText.trim();

  // slash-check सिर्फ़ तभी, जब code collect नहीं कर रहे
  if (session.stage !== 'waiting_code' && text.startsWith('/')) return;

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
    await showProjectsMenu(ctx, session);
  }

  else if (session.stage === 'waiting_new_project_name') {
    if (!text) return ctx.reply('❌ खाली नाम नहीं चलेगा। दोबारा टाइप करें।');
    session.stage = 'idle';
    ctx.reply('⏳ Project बन रहा है...');
    try {
      const projectId = await createProject(session.railwayToken, text);
      session.currentProjectId = projectId;
      await showServicesMenu(ctx, session);
    } catch (err) {
      ctx.reply(`❌ Project नहीं बन पाया: ${err.message}`);
      await showProjectsMenu(ctx, session);
    }
  }

  else if (session.stage === 'waiting_new_service_name') {
    if (!text) return ctx.reply('❌ खाली नाम नहीं चलेगा। दोबारा टाइप करें।');
    session.stage = 'idle';
    ctx.reply('⏳ Service बन रही है...');
    try {
      const svc = await createService(session.railwayToken, session.currentProjectId, text);
      session.currentServiceId = svc.id;
      session.currentServiceName = svc.name;
      await showServiceMenu(ctx, session);
    } catch (err) {
      ctx.reply(`❌ Service नहीं बन पाई: ${err.message}`);
      await showServicesMenu(ctx, session);
    }
  }

  else if (session.stage === 'waiting_filename') {
    session.pendingFilename = text;
    session.fileChunks = [];
    session.stage = 'waiting_code';
    ctx.reply(
      `📄 Now send content of \`${text}\`.\n\n` +
      `⚠️ पूरा code एक ही बार में copy-paste करें (Telegram खुद बड़े paste को बाँट देगा, बॉट सही जोड़ लेगा)। खुद से टुकड़ों में मत बाँटिए।\n\n` +
      `जब पूरा हो जाए तो \`DONE\` टाइप करें।`,
      { parse_mode: 'Markdown' }
    );
  }

  else if (session.stage === 'waiting_code') {
    if (text.toUpperCase() === 'DONE') {
      // 🔑 फिक्स: chunks को बिना किसी separator के जोड़ो। Telegram बड़े
      // paste को खुद कई messages में बाँट देता है — यह सिर्फ़ character-count
      // पर आधारित cut है, इसलिए हर chunk के अंदर के \n/spaces पहले से सही हैं;
      // बीच में अपनी तरफ़ से '\n' जोड़ना ही original text को तोड़ देता है।
      const fullContent = session.fileChunks.join('');
      const fname = session.pendingFilename;
      if (!fullContent) return ctx.reply('❌ No content!');
      const files = getCurrentFiles(session);
      files[fname] = fullContent;
      session.pendingFilename = null;
      session.fileChunks = [];
      session.stage = 'idle';
      ctx.reply(`✅ File \`${fname}\` saved! (${fullContent.length} chars)`, { parse_mode: 'Markdown' });
      await showServiceMenu(ctx, session);
      return;
    }
    session.fileChunks.push(rawText);
    const total = session.fileChunks.reduce((a, c) => a + c.length, 0);
    ctx.reply(`📥 Part received (${rawText.length} chars). Total: ${total}. Send more or \`DONE\`.`);
  }

  else if (session.stage === 'waiting_delete_filename') {
    const files = getCurrentFiles(session);
    if (files[text]) {
      delete files[text];
      ctx.reply(`✅ Deleted \`${text}\``, { parse_mode: 'Markdown' });
    } else {
      ctx.reply(`❌ Not found.`);
    }
    session.stage = 'idle';
    await showServiceMenu(ctx, session);
  }

  else if (session.stage === 'waiting_delete_project_confirm') {
    session.stage = 'idle';
    if (text !== session.currentProjectName) {
      ctx.reply('❌ नाम match नहीं हुआ, delete cancel किया।');
      return await showServicesMenu(ctx, session);
    }
    ctx.reply('⏳ Project डिलीट हो रहा है...');
    try {
      await deleteProject(session.railwayToken, session.currentProjectId);
      // उस project की सारी services की local files भी साफ़ करो
      const details = await getProjectDetails(session.railwayToken, session.currentProjectId).catch(() => null);
      if (details) details.services.forEach(s => delete session.serviceFiles[s.id]);
      ctx.reply('✅ Project डिलीट हो गया।');
      await showProjectsMenu(ctx, session);
    } catch (err) {
      ctx.reply(`❌ Delete नहीं हो पाया: ${err.message}`);
      await showServicesMenu(ctx, session);
    }
  }

  else if (session.stage === 'waiting_delete_service_confirm') {
    session.stage = 'idle';
    if (text !== session.currentServiceName) {
      ctx.reply('❌ नाम match नहीं हुआ, delete cancel किया।');
      return await showServiceMenu(ctx, session);
    }
    ctx.reply('⏳ Service डिलीट हो रही है...');
    try {
      await deleteService(session.railwayToken, session.currentServiceId);
      delete session.serviceFiles[session.currentServiceId];
      ctx.reply('✅ Service डिलीट हो गई।');
      await showServicesMenu(ctx, session);
    } catch (err) {
      ctx.reply(
        `❌ Delete नहीं हो पाया: ${err.message}\n\n` +
        `(यह कभी-कभी Railway की तरफ़ से permission की वजह से fail होता है — ऐसे में Railway dashboard से मैन्युअल delete करें।)`
      );
      await showServiceMenu(ctx, session);
    }
  }

  else {
    ctx.reply('कृपया मेनू बटन इस्तेमाल करें, या /deploy भेजें।');
  }
});

// ------------------------------------------------------------
// 🛡️ GLOBAL ERROR HANDLER
// ------------------------------------------------------------
bot.catch((err, ctx) => {
  console.error(`❌ Unhandled error for update ${ctx?.update?.update_id}:`, err);
  try { ctx.reply('⚠️ कुछ गलत हो गया, कृपया दोबारा कोशिश करें।'); } catch (e) {}
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
