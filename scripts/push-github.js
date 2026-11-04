#!/usr/bin/env node
/**
 * push-github.js — Pushes all project files to GitHub via REST API
 * Usage: GH_TOKEN=xxx node scripts/push-github.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const fs   = require("fs");
const path = require("path");
const https = require("https");

const TOKEN  = process.env.GH_TOKEN;
const OWNER  = "castrolmocro";
const REPO   = "fb-messenger-bot";
const BRANCH = "main";

if (!TOKEN) { console.error("❌ GH_TOKEN not set"); process.exit(1); }

// Files to push (relative to project root)
const ROOT = path.join(__dirname, "..");

const IGNORE = new Set([
  "node_modules", ".git", "data", "appstate.json", "config.json",
  ".env", ".DS_Store", "*.log", ".local"
]);

function shouldIgnore(relPath) {
  const parts = relPath.split("/");
  for (const part of parts) {
    if (IGNORE.has(part)) return true;
    if (part.endsWith(".log")) return true;
    if (part === ".local") return true;
  }
  return false;
}

function getAllFiles(dir, base = "") {
  const results = [];
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const rel  = base ? `${base}/${item}` : item;
    const full = path.join(dir, item);
    if (shouldIgnore(rel)) continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results.push(...getAllFiles(full, rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}

function ghRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "api.github.com",
      path:     `/repos/${OWNER}/${REPO}${endpoint}`,
      method,
      headers: {
        "Authorization":        `Bearer ${TOKEN}`,
        "Accept":               "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent":           "michael-bot-push",
        "Content-Type":         "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getFileSha(filePath) {
  const res = await ghRequest("GET", `/contents/${filePath}?ref=${BRANCH}`);
  if (res.status === 200 && res.data.sha) return res.data.sha;
  return null;
}

async function upsertFile(filePath, content, sha) {
  const body = {
    message: `chore: update ${filePath}`,
    content: Buffer.from(content).toString("base64"),
    branch:  BRANCH,
  };
  if (sha) body.sha = sha;
  return ghRequest("PUT", `/contents/${filePath}`, body);
}

async function ensureBranch() {
  // Check if branch exists
  const res = await ghRequest("GET", `/git/refs/heads/${BRANCH}`);
  if (res.status === 200) {
    console.log(`✔ Branch '${BRANCH}' exists`);
    return true;
  }
  // Get default branch HEAD
  const repoRes = await ghRequest("GET", "");
  if (!repoRes.data.default_branch) {
    console.error("❌ Cannot access repo:", repoRes.status);
    return false;
  }
  const defaultBranch = repoRes.data.default_branch;
  const headRes = await ghRequest("GET", `/git/refs/heads/${defaultBranch}`);
  if (headRes.status !== 200) {
    console.error("❌ Cannot get HEAD:", headRes.status);
    return false;
  }
  // Create main branch
  const sha = headRes.data.object.sha;
  const createRes = await ghRequest("POST", "/git/refs", {
    ref: `refs/heads/${BRANCH}`,
    sha,
  });
  if (createRes.status === 201) {
    console.log(`✔ Created branch '${BRANCH}' from '${defaultBranch}'`);
    return true;
  }
  console.error("❌ Cannot create branch:", createRes.status, JSON.stringify(createRes.data).slice(0, 200));
  return false;
}

async function main() {
  console.log(`\n🚀 Pushing to github.com/${OWNER}/${REPO} (${BRANCH})\n`);

  const ok = await ensureBranch();
  if (!ok) process.exit(1);

  const files = getAllFiles(ROOT);
  console.log(`📁 Found ${files.length} files to push\n`);

  let success = 0;
  let failed  = 0;

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(ROOT, file));
      const sha     = await getFileSha(file);
      const res     = await upsertFile(file, content, sha);

      if (res.status === 200 || res.status === 201) {
        console.log(`  ✔ ${file}`);
        success++;
      } else {
        console.error(`  ✘ ${file} — ${res.status}: ${JSON.stringify(res.data).slice(0, 120)}`);
        failed++;
      }
    } catch (e) {
      console.error(`  ✘ ${file} — ${e.message}`);
      failed++;
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\n✔ Done: ${success} pushed, ${failed} failed`);
  if (failed === 0) console.log(`\n🎉 All files pushed to https://github.com/${OWNER}/${REPO}/tree/${BRANCH}`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
