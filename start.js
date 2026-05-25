const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const https = require('https');

// Load environment variables from .env file if it exists
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  try {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const parts = trimmed.split('=');
        const key = parts[0].trim();
        const value = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
        if (key && value && process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    });
    console.log(`📝 Loaded environment variables from .env file.`);
  } catch (err) {
    console.error(`⚠️ Failed to parse .env file:`, err);
  }
}

// Pterodactyl servers automatically provide the PORT environment variable.
// We retrieve it or fallback to the default port 3000.
const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

process.env.PORT = PORT;
process.env.HOST = HOST;

const bundlePath = path.join(__dirname, '.output', 'server', 'index.mjs');

console.log(`=========================================`);
console.log(`🚀 Starting Simple Proxy Server...`);
console.log(`📍 Address: http://${HOST}:${PORT}`);
console.log(`=========================================`);

const forceBuild = process.env.FORCE_BUILD === 'true';

if (!fs.existsSync(bundlePath) || forceBuild) {
  if (forceBuild) {
    console.log(`🔄 FORCE_BUILD is enabled. Forcing re-compilation of the production bundle...`);
  } else {
    console.log(`⚠️ Production build not found at: ${bundlePath}`);
  }
  
  try {
    console.log(`⚙️ Automatically running 'npm run build:node'... (this might take a few seconds)`);
    execSync('npm run build:node', { stdio: 'inherit', cwd: __dirname });
    console.log(`✅ Compilation successful!`);
  } catch (error) {
    console.error(`❌ Compilation failed! Please run 'npm run build:node' manually.`);
    process.exit(1);
  }
}

// Helper to download files supporting HTTP redirects
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`Status ${response.statusCode}`));
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

// Get the correct cloudflared binary release URL based on platform/arch
function getCloudflaredUrl() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'win32') {
    if (arch === 'x64') return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
    return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-386.exe';
  } else if (platform === 'linux') {
    if (arch === 'x64') return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
    if (arch === 'arm64') return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64';
    if (arch === 'arm') return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm';
  } else if (platform === 'darwin') {
    return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64';
  }
  return null;
}

// Set up and run Cloudflare Tunnel dynamically
async function setupAndStartTunnel(port) {
  const binaryName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const binaryPath = path.join(__dirname, binaryName);

  if (!fs.existsSync(binaryPath)) {
    const downloadUrl = getCloudflaredUrl();
    if (!downloadUrl) {
      console.error(`❌ Cloudflare Tunnel not supported on this platform: ${process.platform} ${process.arch}`);
      return;
    }
    console.log(`☁️ Cloudflare Tunnel binary not found. Downloading the correct binary for ${process.platform}-${process.arch}...`);
    console.log(`⬇️ Download URL: ${downloadUrl}`);
    try {
      await downloadFile(downloadUrl, binaryPath);
      if (process.platform !== 'win32') {
        fs.chmodSync(binaryPath, '755');
      }
      console.log(`✅ Cloudflare Tunnel binary downloaded and configured successfully!`);
    } catch (err) {
      console.error(`❌ Failed to download Cloudflare Tunnel binary:`, err.message);
      return;
    }
  }

  const tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN;
  let args = [];

  if (tunnelToken) {
    console.log(`☁️ Starting Cloudflare Tunnel using your custom tunnel token...`);
    args = ['tunnel', '--no-autoupdate', 'run', '--token', tunnelToken];
  } else {
    console.log(`☁️ Starting free, dynamic Cloudflare Tunnel to expose port ${port} securely...`);
    args = ['tunnel', '--url', `http://localhost:${port}`];
  }

  const child = spawn(binaryPath, args);

  let parsed = false;
  const parseTunnelUrl = (data) => {
    if (parsed) return;
    const output = data.toString();
    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match) {
      parsed = true;
      const url = match[0];
      console.log(`\n=============================================================`);
      console.log(`🎉 CLOUDFLARE SECURE HTTPS TUNNEL IS LIVE!`);
      console.log(`🔗 PROXY HTTPS URL: \x1b[36m${url}\x1b[0m`);
      console.log(`📝 Paste the URL above in your frontend custom worker setting!`);
      console.log(`=============================================================\n`);
    }
  };

  child.stdout.on('data', parseTunnelUrl);
  child.stderr.on('data', parseTunnelUrl);

  // If running with a token, print success message once connected
  if (tunnelToken) {
    console.log(`\n=============================================================`);
    console.log(`🎉 CLOUDFLARE CUSTOM DOMAIN TUNNEL IS ACTIVE!`);
    console.log(`🔗 Connected using the provided token.`);
    console.log(`📝 Your proxy is now permanently live on your custom domain!`);
    console.log(`=============================================================\n`);
  }

  child.on('close', (code) => {
    console.log(`⚠️ Cloudflare Tunnel process exited with code ${code}`);
  });
}

// Start Cloudflare Tunnel concurrently if requested
if (process.env.CLOUDFLARE_TUNNEL === 'true' || process.env.CLOUDFLARE_TUNNEL_TOKEN) {
  setupAndStartTunnel(PORT);
}

// Load the compiled Nitro ES Module bundle dynamically
import(bundlePath).catch((err) => {
  console.error(`❌ Server crash or initialization failed:`, err);
  process.exit(1);
});
