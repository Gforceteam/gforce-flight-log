const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = 'brookewhatnall';
const REPO_NAME = 'gforce-api';
const BACKUP_PATH = 'data/backup.json';
const BACKUP_BRANCH = 'main';

function githubRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
    }
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getFileSha(path) {
  try {
    const result = await githubRequest('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}?ref=${BACKUP_BRANCH}`);
    return result.sha || null;
  } catch { return null; }
}

async function loadBackup() {
  // Try raw public URL first — no token needed, survives Render cold starts
  try {
    const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BACKUP_BRANCH}/${BACKUP_PATH}`;
    const data = await new Promise((resolve, reject) => {
      https.get(rawUrl, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Bad JSON')); } });
      }).on('error', reject);
    });
    if (data && data.flights) {
      console.log(`📦 Backup restored (raw): ${data.flights?.length || 0} flights, ${data.pilots?.length || 0} pilots`);
      return data;
    }
  } catch (e) {
    console.log('📦 Raw backup fetch failed, trying API:', e.message);
  }

  // Fall back to authenticated GitHub API
  if (!GITHUB_TOKEN) {
    console.log('📦 No GITHUB_TOKEN, skipping backup restore');
    return null;
  }
  try {
    const result = await githubRequest('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${BACKUP_PATH}?ref=${BACKUP_BRANCH}`);
    if (result.content) {
      const json = Buffer.from(result.content, 'base64').toString('utf8');
      const data = JSON.parse(json);
      console.log(`📦 Backup restored: ${data.flights?.length || 0} flights, ${data.pilots?.length || 0} pilots`);
      return data;
    }
  } catch (e) {
    console.log('📦 No backup found or restore failed:', e.message);
  }
  return null;
}

async function saveBackup(db) {
  if (!GITHUB_TOKEN) return;

  try {
    // Export current data
    const pilots = db.exec('SELECT * FROM pilots').map(t => {
      const cols = t.columns;
      return t.values.map(v => {
        const row = {};
        cols.forEach((c, i) => row[c] = v[i]);
        return row;
      });
    }).flat();

    const flights = db.exec('SELECT * FROM flights').map(t => {
      const cols = t.columns;
      return t.values.map(v => {
        const row = {};
        cols.forEach((c, i) => row[c] = v[i]);
        return row;
      });
    }).flat();

    const activeTimers = db.exec('SELECT * FROM active_timers').map(t => {
      const cols = t.columns;
      return t.values.map(v => {
        const row = {};
        cols.forEach((c, i) => row[c] = v[i]);
        return row;
      });
    }).flat();

    const backup = {
      version: 1,
      saved_at: new Date().toISOString(),
      pilots,
      flights,
      active_timers: activeTimers
    };

    const content = Buffer.from(JSON.stringify(backup)).toString('base64');
    const sha = await getFileSha(BACKUP_PATH);

    await githubRequest('PUT', `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${BACKUP_PATH}`, {
      message: `Backup: ${flights.length} flights, ${pilots.length} pilots`,
      content,
      branch: BACKUP_BRANCH,
      sha: sha || undefined
    });
    console.log(`💾 Backup saved to GitHub: ${flights.length} flights`);
  } catch (e) {
    console.error('💾 Backup failed:', e.message);
  }
}

module.exports = { loadBackup, saveBackup };
