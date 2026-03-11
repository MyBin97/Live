const fs = require('fs');
const https = require('https');
const http = require('http');

// 配置
const CONFIG = {
  baseUrl: "http://zhibo.aisimu.cn/zhubo/",
  timeout: 15000,
  concurrentLimit: 3,  // 控制并发，避免目标网站封IP
  headers: {
    "Cookie": "SITE_TOTAL_ID=7c7cfb9631fe101240995d077685002c; PHPSESSID=6bfe561e341d14bca2f1282f8e138a6b",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
  }
};

// 封装 HTTP 请求（支持 gzip/deflate）
function fetchWithTimeout(url, timeout = CONFIG.timeout) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: CONFIG.headers, timeout }, (res) => {
      let data = [];
      
      // 处理重定向
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        const redirectUrl = res.headers.location;
        console.log(`  重定向: ${redirectUrl}`);
        return resolve(fetchWithTimeout(redirectUrl, timeout));
      }
      
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(data);
        // 简单处理 gzip（实际可能需要 zlib 解压）
        resolve(buffer.toString('utf-8'));
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    
    setTimeout(() => {
      req.destroy();
      reject(new Error('Timeout'));
    }, timeout);
  });
}

// 获取平台列表
async function getPlatforms() {
  console.log('正在获取平台列表...');
  const html = await fetchWithTimeout(CONFIG.baseUrl);
  
  const platforms = [];
  const regex = /<div class="category-title">([^<]+)<\/div>[\s\S]*?<a target="_blank" href="([^"]+)" class="view-btn">查看主播<\/a>/g;
  let match;
  
  while ((match = regex.exec(html)) !== null) {
    const name = match[1].trim();
    const href = match[2].trim();
    
    if (name === "卫视直播") {
      console.log(`  跳过: ${name}`);
      continue;
    }
    
    platforms.push({
      name,
      url: CONFIG.baseUrl + href
    });
  }
  
  console.log(`找到 ${platforms.length} 个平台`);
  return platforms;
}

// 获取单个平台的直播源
async function getStreamers(platform) {
  try {
    const html = await fetchWithTimeout(platform.url);
    const streamers = [];
    
    const regex = /<td class="col-anchor">([^<]+)<\/td>[\s\S]*?play\.php\?videoUrl=([^&]+)&/g;
    let match;
    
    while ((match = regex.exec(html)) !== null) {
      streamers.push({
        title: match[1].trim(),
        address: decodeURIComponent(match[2].trim())
      });
    }
    
    console.log(`  ${platform.name}: ${streamers.length} 个主播`);
    return { platform, streamers };
  } catch (e) {
    console.error(`  ${platform.name} 获取失败: ${e.message}`);
    return { platform, streamers: [] };
  }
}

// 分批处理（控制并发）
async function processBatch(items, batchSize, processor) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    console.log(`处理批次 ${Math.floor(i/batchSize) + 1}/${Math.ceil(items.length/batchSize)}...`);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
    // 批次间延迟，避免请求过快
    if (i + batchSize < items.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return results;
}

// 生成 M3U 文件
async function generateM3U() {
  try {
    const platforms = await getPlatforms();
    if (platforms.length === 0) {
      throw new Error('未获取到任何平台');
    }
    
    // 分批获取所有直播源
    const results = await processBatch(platforms, CONFIG.concurrentLimit, getStreamers);
    
    // 去重并生成 M3U
    const addedAddresses = new Set();
    let m3uContent = "#EXTM3U\n";
    let validCount = 0;
    let duplicateCount = 0;
    let emptyCount = 0;
    
    for (const { platform, streamers } of results) {
      for (const streamer of streamers) {
        const title = (streamer.title || "未知直播").replace(/[,]/g, "");
        const address = (streamer.address || "").trim();
        
        if (!address) {
          emptyCount++;
          continue;
        }
        
        if (addedAddresses.has(address)) {
          duplicateCount++;
          continue;
        }
        
        addedAddresses.add(address);
        m3uContent += `\n#EXTINF:-1 tvg-id="${title}" tvg-name="${title}" group-title="大秀直播",${title}\n${address}`;
        validCount++;
      }
    }
    
    // 写入文件
    fs.writeFileSync('live.m3u', m3uContent, 'utf-8');
    
    console.log('\n========== 生成报告 ==========');
    console.log(`有效直播源: ${validCount}`);
    console.log(`重复数量: ${duplicateCount}`);
    console.log(`空地址数量: ${emptyCount}`);
    console.log(`总计处理: ${validCount + duplicateCount + emptyCount}`);
    console.log('==============================');
    console.log('文件已保存: live.m3u');
    
    return validCount;
  } catch (e) {
    console.error('生成失败:', e.message);
    process.exit(1);
  }
}

// 执行
generateM3U();
