const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// 配置
const CONFIG = {
  baseUrl: "http://zhibo.aisimu.cn/zhubo/",
  timeout: 15000,
  concurrentLimit: 3,
  headers: {
    "Cookie": "SITE_TOTAL_ID=7c7cfb9631fe101240995d077685002c; PHPSESSID=6bfe561e341d14bca2f1282f8e138a6b",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Connection": "keep-alive",
    "Cache-Control": "no-cache"
  }
};

// 请求封装：不移除解压、但不主动要求压缩，避免截断丢失内容
function fetchWithTimeout(url, timeout = CONFIG.timeout) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: CONFIG.headers, timeout }, (res) => {
      let data = [];

      // 重定向
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        const redirectUrl = new URL(res.headers.location, url).href;
        return resolve(fetchWithTimeout(redirectUrl, timeout));
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      // 直接拼接数据，不解压（你说网页不需要解压）
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(data);
        resolve(buffer.toString('utf8'));
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

// 获取平台
async function getPlatforms() {
  console.log('正在获取平台列表...');
  let html;
  try {
    html = await fetchWithTimeout(CONFIG.baseUrl);
  } catch (e) {
    throw new Error(`获取平台失败: ${e.message}`);
  }

  const platforms = [];
  // 修复：更宽松、更准的正则
  const regex = /<div class="category-title">([\s\S]*?)<\/div>[\s\S]*?href="([^"]+)"[^>]*>查看主播/g;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const name = match[1].trim().replace(/\s+/g, ' ');
    let href = match[2].trim();

    if (name.includes("卫视")) continue;

    const platformUrl = new URL(href, CONFIG.baseUrl).href;
    platforms.push({ name, url: platformUrl });
  }

  console.log(`找到平台：${platforms.length} 个`);
  return platforms;
}

// 获取主播源（修复正则，不漏抓）
async function getStreamers(platform) {
  try {
    const html = await fetchWithTimeout(platform.url);
    const streamers = [];

    // 修复：更健壮、不丢流的正则
    const regex = /<td class="col-anchor">([\s\S]*?)<\/td>[\s\S]*?videoUrl=([^&]+)/g;
    let match;

    while ((match = regex.exec(html)) !== null) {
      const title = match[1].trim() || '未知主播';
      let address = match[2].trim();

      try { address = decodeURIComponent(address); } catch {}
      if (!address || address === 'undefined') continue;

      streamers.push({ title, address });
    }

    console.log(`✅ ${platform.name}：${streamers.length} 个`);
    return { platform, streamers };
  } catch (e) {
    console.error(`❌ ${platform.name} 失败：${e.message}`);
    return { platform, streamers: [] };
  }
}

// 并发控制
async function processBatch(items, batchSize, processor) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(item => processor(item).catch(err => ({ platform: item, streamers: [] })))
    );
    results.push(...batchResults);
    await new Promise(r => setTimeout(r, 800));
  }
  return results;
}

// 生成 M3U（真正按【平台+名称+地址】三重去重，不乱丢）
async function generateM3U() {
  try {
    const platforms = await getPlatforms();
    const results = await processBatch(platforms, CONFIG.concurrentLimit, getStreamers);

    const uniqueKey = new Set();
    let m3uContent = "#EXTM3U\n";
    let valid = 0, dup = 0;

    for (const { platform, streamers } of results) {
      for (const s of streamers) {
        const cleanTitle = s.title.replace(/[,|\n\r]/g, '').trim();
        const addr = s.address.trim();
        if (!addr) continue;

        // 三重去重：平台 + 标题 + 地址（真正不丢、不乱删）
        const key = `${platform.name}||${cleanTitle}||${addr}`;
        if (uniqueKey.has(key)) {
          dup++;
          continue;
        }
        uniqueKey.add(key);

        m3uContent += `#EXTINF:-1 tvg-id="${cleanTitle}" tvg-name="${cleanTitle}" group-title="${platform.name}",${cleanTitle}\n${addr}\n`;
        valid++;
      }
    }

    fs.writeFileSync('live.m3u', m3uContent, 'utf8');

    console.log('\n======== 生成完成 ========');
    console.log('有效源：', valid);
    console.log('重复：', dup);
    console.log('文件保存：live.m3u');

  } catch (e) {
    console.error('失败：', e.message);
    process.exit(1);
  }
}

generateM3U();
